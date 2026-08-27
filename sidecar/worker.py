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

import fitz  # PyMuPDF
from bullmq import Worker

from blobstore import BlobStore
from triage import choose_dpi, rasterize, rasterize_image_file, triage_text_layer

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
    with fitz.open(stream=data, filetype="pdf") as doc:
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
        }
    ]


async def process(job, job_token) -> dict[str, Any]:  # noqa: ANN001 - bullmq types
    payload = job.data
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
