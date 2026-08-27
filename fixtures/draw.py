"""Low-level drawing helpers for synthetic tax forms.

Everything here produces a *native digital* PDF with a real text layer. Scanned and
phone-photo variants are derived from these by `degrade.py`, which is the right order:
the text-layer triage in P2 has to distinguish the two, and deriving one from the other
guarantees the content is identical so a triage difference is the only variable.

Layouts are IRS-*like*, not IRS-exact. They carry the boxes, numbers, and labels the
extractor cares about, in plausible positions, which is what exercises the pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pymupdf

LETTER = pymupdf.paper_rect("letter")
MARGIN = 36.0

FONT = "helv"
FONT_BOLD = "hebo"

BLACK = (0, 0, 0)
GREY = (0.45, 0.45, 0.45)


@dataclass
class Box:
    """One labelled box on a form."""
    label: str
    value: str | None
    x: float
    y: float
    w: float
    h: float
    box_id: str = ""
    label_size: float = 5.5
    value_size: float = 9.0
    value_bold: bool = False


@dataclass
class FormPage:
    title: str
    subtitle: str = ""
    year: int = 2025
    boxes: list[Box] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    checkboxes: list[tuple[str, float, float, bool]] = field(default_factory=list)
    free_text: list[tuple[str, float, float, float, bool]] = field(default_factory=list)


def new_doc() -> pymupdf.Document:
    return pymupdf.open()


def add_page(doc: pymupdf.Document, page: FormPage) -> pymupdf.Page:
    p = doc.new_page(width=LETTER.width, height=LETTER.height)

    # Header block.
    p.insert_text((MARGIN, MARGIN + 10), page.title, fontname=FONT_BOLD, fontsize=14)
    if page.subtitle:
        p.insert_text((MARGIN, MARGIN + 24), page.subtitle, fontname=FONT, fontsize=8, color=GREY)
    p.insert_text(
        (LETTER.width - MARGIN - 70, MARGIN + 10),
        str(page.year),
        fontname=FONT_BOLD,
        fontsize=16,
    )
    p.draw_line(
        pymupdf.Point(MARGIN, MARGIN + 32),
        pymupdf.Point(LETTER.width - MARGIN, MARGIN + 32),
        color=BLACK,
        width=1.1,
    )

    for box in page.boxes:
        rect = pymupdf.Rect(box.x, box.y, box.x + box.w, box.y + box.h)
        p.draw_rect(rect, color=BLACK, width=0.6)
        tag = f"{box.box_id} " if box.box_id else ""
        p.insert_text(
            (box.x + 3, box.y + 8),
            f"{tag}{box.label}"[:62],
            fontname=FONT,
            fontsize=box.label_size,
            color=GREY,
        )
        # A blank box gets NO text at all. That is the whole point of the fixture set:
        # the extractor must return null here, not zero (§5).
        if box.value is not None:
            p.insert_text(
                (box.x + 5, box.y + box.h - 6),
                box.value,
                fontname=FONT_BOLD if box.value_bold else FONT,
                fontsize=box.value_size,
            )

    for label, x, y, checked in page.checkboxes:
        rect = pymupdf.Rect(x, y, x + 9, y + 9)
        p.draw_rect(rect, color=BLACK, width=0.8)
        if checked:
            p.insert_text((x + 1.5, y + 7.5), "X", fontname=FONT_BOLD, fontsize=8)
        p.insert_text((x + 13, y + 7.5), label, fontname=FONT, fontsize=7)

    for text, x, y, size, bold in page.free_text:
        p.insert_text((x, y), text, fontname=FONT_BOLD if bold else FONT, fontsize=size)

    y = LETTER.height - MARGIN - 8 * len(page.notes)
    for note in page.notes:
        p.insert_text((MARGIN, y), note, fontname=FONT, fontsize=6.5, color=GREY)
        y += 8

    return p


def money(cents: int | None) -> str | None:
    """Format cents the way a form prints them. None stays None — a blank box."""
    if cents is None:
        return None
    negative = cents < 0
    whole, frac = divmod(abs(cents), 100)
    s = f"{whole:,}.{frac:02d}"
    return f"({s})" if negative else s


def printed_zero() -> str:
    """The IRS convention for an explicitly-printed zero, distinct from a blank box."""
    return "-0-"


def grid(
    entries: list[tuple[str, str, str | None]],
    *,
    top: float = 150.0,
    left: float = MARGIN,
    width: float = LETTER.width - 2 * MARGIN,
    columns: int = 2,
    row_h: float = 30.0,
    gap: float = 6.0,
) -> list[Box]:
    """Lay (box_id, label, value) triples out in a simple grid."""
    col_w = (width - gap * (columns - 1)) / columns
    boxes: list[Box] = []
    for index, (box_id, label, value) in enumerate(entries):
        row, col = divmod(index, columns)
        boxes.append(
            Box(
                label=label,
                value=value,
                x=left + col * (col_w + gap),
                y=top + row * (row_h + gap),
                w=col_w,
                h=row_h,
                box_id=box_id,
            )
        )
    return boxes


def party_block(
    p: pymupdf.Page,
    *,
    left_title: str,
    left_lines: list[str],
    right_title: str,
    right_lines: list[str],
    top: float = 70.0,
) -> None:
    """Payer/recipient identification block, as printed at the top of most 1099s."""
    half = (LETTER.width - 2 * MARGIN - 6) / 2
    for x, title, lines in (
        (MARGIN, left_title, left_lines),
        (MARGIN + half + 6, right_title, right_lines),
    ):
        rect = pymupdf.Rect(x, top, x + half, top + 66)
        p.draw_rect(rect, color=BLACK, width=0.6)
        p.insert_text((x + 3, top + 9), title, fontname=FONT, fontsize=5.5, color=GREY)
        y = top + 22
        for line in lines:
            p.insert_text((x + 5, y), line, fontname=FONT, fontsize=8)
            y += 11
