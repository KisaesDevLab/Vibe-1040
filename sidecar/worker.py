"""Python sidecar worker (P0, P2).

The queue is the boundary between TypeScript and Python (§12). This worker consumes the
`v1040.raster` BullMQ queue, does the PyMuPDF/Pillow work that has no good TS equivalent,
writes page rasters back to the same encrypted blob store, and returns page metadata for
the TS side to persist.

It holds no router credentials and makes no AI calls. All inference goes through the
router, from the TypeScript side (§3).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from typing import Any

import pymupdf
from bullmq import Worker

from blobstore import BlobStore
from triage import (
    choose_dpi,
    extract_layout_spans,
    rasterize,
    rasterize_image_file,
    triage_text_layer,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "info").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("vibe1040.sidecar")

QUEUE = "v1040.raster"

RASTER_DPI_DEFAULT = int(os.environ.get("RASTER_DPI_DEFAULT", "300"))
RASTER_DPI_DIGITAL = int(os.environ.get("RASTER_DPI_DIGITAL", "200"))
RASTER_DPI_DEGRADED = int(os.environ.get("RASTER_DPI_DEGRADED", "400"))
RASTER_MAX_EDGE_PX = int(os.environ.get("RASTER_MAX_EDGE_PX", "2200"))
RASTER_JPEG_QUALITY = int(os.environ.get("RASTER_JPEG_QUALITY", "82"))

store = BlobStore()


def _process_pdf(bundle_id: str, source_file_id: str, data: bytes) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for index, page in enumerate(doc, start=1):
            result = triage_text_layer(page)
            dpi = choose_dpi(
                result,
                default=RASTER_DPI_DEFAULT,
                digital=RASTER_DPI_DIGITAL,
                degraded=RASTER_DPI_DEGRADED,
            )
            jpeg, width, height = rasterize(
                page,
                dpi=dpi,
                max_edge_px=RASTER_MAX_EDGE_PX,
                jpeg_quality=RASTER_JPEG_QUALITY,
            )
            raster_key = f"bundles/{bundle_id}/raster/{source_file_id}-{index}.jpg"
            store.put(raster_key, jpeg)

            # A usable text layer carries exact word boxes. Measure them here so the layout
            # stage needs no model for this page (§4, decision 2026-09-16). A raster page has
            # nothing to measure and goes to the vision layout pass as before.
            layout_spans = extract_layout_spans(page) if result.route == "text_layer" else None

            pages.append(
                {
                    "pageNumber": index,
                    "route": result.route,
                    "hasTextLayer": result.has_text_layer,
                    "textLayerGarbled": result.garbled,
                    "textLayer": result.text,
                    "dpi": dpi,
                    "encoding": "image/jpeg",
                    "widthPx": width,
                    "heightPx": height,
                    "encodedBytes": len(jpeg),
                    "rasterStorageKey": raster_key,
                    "triageReason": result.reason,
                    "layoutSpans": layout_spans,
                }
            )
    return pages


def _process_image(bundle_id: str, source_file_id: str, data: bytes) -> list[dict[str, Any]]:
    jpeg, width, height = rasterize_image_file(
        data, max_edge_px=RASTER_MAX_EDGE_PX, jpeg_quality=RASTER_JPEG_QUALITY
    )
    raster_key = f"bundles/{bundle_id}/raster/{source_file_id}-1.jpg"
    store.put(raster_key, jpeg)
    return [
        {
            "pageNumber": 1,
            "route": "raster",
            "hasTextLayer": False,
            "textLayerGarbled": False,
            "textLayer": None,
            "dpi": RASTER_DPI_DEFAULT,
            "encoding": "image/jpeg",
            "widthPx": width,
            "heightPx": height,
            "encodedBytes": len(jpeg),
            "rasterStorageKey": raster_key,
            "triageReason": "loose image",
            "layoutSpans": None,
        }
    ]


def _assemble(payload: dict[str, Any]) -> dict[str, Any]:
    """Bind the bundle's source pages into one PDF in return order, with bookmarks.

    Pages from a PDF are inserted as-is, so each keeps its own text layer; a loose image
    becomes a page of its own size. The outline has one level-1 entry per return section
    (Wages, Interest, …) and a level-2 entry per document naming the form and the issuer.
    """
    out = pymupdf.open()
    toc: list[list[Any]] = []
    opened: dict[str, pymupdf.Document] = {}
    try:
        for section in payload["sections"]:
            section_start: int | None = None
            entries: list[list[Any]] = []
            for entry in section["entries"]:
                entry_start = out.page_count
                for page_ref in entry["pages"]:
                    key = page_ref["storageKey"]
                    number = int(page_ref["pageNumber"])
                    if page_ref["mediaType"] == "application/pdf":
                        src = opened.get(key)
                        if src is None:
                            src = pymupdf.open(stream=store.get(key), filetype="pdf")
                            opened[key] = src
                        if 1 <= number <= src.page_count:
                            out.insert_pdf(src, from_page=number - 1, to_page=number - 1)
                    else:
                        data = store.get(key)
                        with pymupdf.open(stream=data) as image_doc:
                            rect = image_doc[0].rect
                        page = out.new_page(width=rect.width, height=rect.height)
                        page.insert_image(page.rect, stream=data)
                if out.page_count > entry_start:
                    if section_start is None:
                        section_start = entry_start
                    entries.append([2, entry["title"], entry_start + 1])
            if section_start is not None:
                toc.append([1, section["label"], section_start + 1])
                toc.extend(entries)
        out.set_toc(toc)
        page_count = out.page_count
        data = out.tobytes(deflate=True, garbage=3)
    finally:
        for src in opened.values():
            src.close()
        out.close()
    store.put(payload["outputKey"], data)
    return {"kind": "assemble", "bundleId": payload["bundleId"], "pageCount": page_count, "bytes": len(data)}


async def process(job, job_token) -> dict[str, Any]:  # noqa: ANN001 - bullmq types
    payload = job.data
    if payload.get("kind") == "assemble":
        log.info("assembling sorted PDF for bundle %s", payload["bundleId"])
        result = _assemble(payload)
        log.info("assembled %s: %d bytes", payload["bundleId"], result["bytes"])
        return result
    bundle_id: str = payload["bundleId"]
    source_file_id: str = payload["sourceFileId"]
    storage_key: str = payload["storageKey"]
    media_type: str = payload["mediaType"]

    log.info("rasterizing %s (%s)", source_file_id, media_type)
    data = store.get(storage_key)

    if media_type == "application/pdf":
        pages = _process_pdf(bundle_id, source_file_id, data)
    else:
        pages = _process_image(bundle_id, source_file_id, data)

    total = sum(p["encodedBytes"] for p in pages)
    log.info(
        "rasterized %s: %d page(s), %.1f KB encoded, %.1f KB/page",
        source_file_id,
        len(pages),
        total / 1024,
        (total / len(pages)) / 1024 if pages else 0,
    )
    return {"sourceFileId": source_file_id, "pages": pages}


async def main() -> None:
    redis_url = os.environ["REDIS_URL"]
    concurrency = int(os.environ.get("SIDECAR_CONCURRENCY", "2"))
    worker = Worker(QUEUE, process, {"connection": redis_url, "concurrency": concurrency})
    log.info("sidecar listening on %s (concurrency %d)", QUEUE, concurrency)

    stop = asyncio.Event()
    try:
        await stop.wait()
    finally:
        await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
