"""Turn a native digital PDF into scanned and phone-photo variants.

P2's triage decision has to be correct on every page across "native PDFs, scans, and phone
photos". Deriving the degraded variants from the same source PDF means the *content* is
identical and the only variable is the thing being tested: whether the page carries a
usable text layer.

The scanned variant has **no text layer at all** — it is a page image wrapped in a PDF,
which is what a real scanner produces. The phone photo adds the things a phone adds:
rotation, uneven lighting, perspective, and JPEG noise.
"""
from __future__ import annotations

import io
import random

import pymupdf
from PIL import Image, ImageEnhance, ImageFilter


def _render(doc: pymupdf.Document, page_number: int, dpi: int) -> Image.Image:
    page = doc[page_number]
    pix = page.get_pixmap(dpi=dpi)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")


def scanned(source: pymupdf.Document, *, dpi: int = 200, seed: int = 7) -> pymupdf.Document:
    """A flatbed scan: slight skew, speckle, softened edges, and no text layer."""
    rng = random.Random(seed)
    out = pymupdf.open()

    for page_number in range(source.page_count):
        image = _render(source, page_number, dpi)

        # Scanners introduce a fraction of a degree of skew and a grey background.
        image = image.rotate(rng.uniform(-0.7, 0.7), resample=Image.BICUBIC, fillcolor=248)
        image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.88, 0.97))
        image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.96, 1.02))
        image = image.filter(ImageFilter.GaussianBlur(radius=0.4))

        # Speckle.
        pixels = image.load()
        assert pixels is not None
        for _ in range(int(image.width * image.height * 0.0006)):
            x = rng.randrange(image.width)
            y = rng.randrange(image.height)
            pixels[x, y] = rng.choice([0, 40, 90])

        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=72, optimize=True)

        page = out.new_page(width=source[page_number].rect.width, height=source[page_number].rect.height)
        page.insert_image(page.rect, stream=buffer.getvalue())

    return out


def phone_photo(source: pymupdf.Document, *, page_number: int = 0, dpi: int = 190, seed: int = 11) -> bytes:
    """A photo taken by hand: rotation, keystone, a lighting gradient, and JPEG artefacts."""
    rng = random.Random(seed)
    image = _render(source, page_number, dpi).convert("RGB")

    # Perspective: the top edge is further from the lens than the bottom.
    w, h = image.size
    squeeze = int(w * 0.045)
    image = image.transform(
        (w, h),
        Image.QUAD,
        (squeeze, 0, 0, h, w, h, w - squeeze, 0),
        resample=Image.BICUBIC,
        fillcolor=(235, 233, 228),
    )

    image = image.rotate(rng.uniform(-3.5, 3.5), resample=Image.BICUBIC, expand=True,
                         fillcolor=(235, 233, 228))

    # Lighting gradient — brighter near the window, dimmer in the corner.
    gradient = Image.linear_gradient("L").resize(image.size).rotate(35, resample=Image.BICUBIC)
    shadow = Image.new("RGB", image.size, (0, 0, 0))
    image = Image.composite(image, shadow, gradient.point(lambda v: 150 + v // 3))

    image = ImageEnhance.Sharpness(image).enhance(0.75)
    image = image.filter(ImageFilter.GaussianBlur(radius=0.5))

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=62, optimize=True)
    return buffer.getvalue()
