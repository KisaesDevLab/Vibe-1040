"""Text-layer triage and rasterization (P2).

Per page, probe the embedded text layer with PyMuPDF. If it is empty or CID-garbled, the
page goes down the raster path; otherwise the text layer is kept available for footing
checks *alongside* the raster. Both, not either — the raster is what the layout pass reads,
and the text layer is a cheap cross-check.

Rasterization targets the image-transport budget in CLAUDE.md §3: grayscale JPEG, one page
per request, downscaled to a configured ceiling before encoding.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Literal

import pymupdf
from PIL import Image

Route = Literal["text_layer", "raster"]

# A CID-garbled extraction is the classic symptom of a PDF whose fonts carry no usable
# ToUnicode map: text comes back as (cid:NN) runs or replacement characters.
_CID_PATTERN = re.compile(r"\(cid:\d+\)")
_REPLACEMENT = "�"


@dataclass(frozen=True)
class TriageResult:
    route: Route
    has_text_layer: bool
    garbled: bool
    text: str | None
    char_count: int
    reason: str


def triage_text_layer(page: pymupdf.Page, min_chars: int = 40) -> TriageResult:
    """Decide whether a page's embedded text is trustworthy.

    Conservative on purpose: anything doubtful goes down the raster path, because a bad
    text layer produces confident wrong numbers while a raster just costs an inference.
    """
    text = page.get_text("text") or ""
    stripped = text.strip()

    if not stripped:
        return TriageResult("raster", False, False, None, 0, "no embedded text")

    cid_hits = len(_CID_PATTERN.findall(stripped))
    replacement_hits = stripped.count(_REPLACEMENT)
    garbled = cid_hits > 0 or replacement_hits > len(stripped) * 0.02

    if garbled:
        return TriageResult(
            "raster", True, True, None, len(stripped),
            f"garbled text layer (cid:{cid_hits}, replacement:{replacement_hits})",
        )

    if len(stripped) < min_chars:
        # A scanned page sometimes carries a stray label or a stamp in real text. Too few
        # characters to be a form's worth of content means treat it as an image.
        return TriageResult(
            "raster", True, False, stripped, len(stripped),
            f"text layer too sparse ({len(stripped)} chars)",
        )

    return TriageResult("text_layer", True, False, stripped, len(stripped), "usable text layer")


def choose_dpi(result: TriageResult, *, default: int, digital: int, degraded: int) -> int:
    """300 DPI baseline, 200 for clean digital PDFs, 400 for degraded scans (P2)."""
    if result.route == "text_layer":
        return digital
    if result.garbled or result.char_count == 0:
        return default if not result.garbled else degraded
    return default


def rasterize(
    page: pymupdf.Page,
    *,
    dpi: int,
    max_edge_px: int,
    jpeg_quality: int,
) -> tuple[bytes, int, int]:
    """Render one page to a grayscale JPEG.

    Returns (jpeg_bytes, width_px, height_px). Downscaling happens *before* encoding —
    sending a 600 DPI page to a model that will downsample it anyway just inflates the
    request body for nothing (§3).
    """
    pixmap = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    image = Image.frombytes("L", (pixmap.width, pixmap.height), pixmap.samples)

    longest = max(image.width, image.height)
    if longest > max_edge_px:
        scale = max_edge_px / longest
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.LANCZOS,
        )

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True, progressive=False)
    return buffer.getvalue(), image.width, image.height


def rasterize_image_file(
    data: bytes,
    *,
    max_edge_px: int,
    jpeg_quality: int,
) -> tuple[bytes, int, int]:
    """Loose images (phone photos) join the same path as rendered PDF pages."""
    image = Image.open(io.BytesIO(data))
    image = image.convert("L")

    longest = max(image.width, image.height)
    if longest > max_edge_px:
        scale = max_edge_px / longest
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.LANCZOS,
        )

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True, progressive=False)
    return buffer.getvalue(), image.width, image.height
