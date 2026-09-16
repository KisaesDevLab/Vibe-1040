"""Fixtures built on the IRS's own fillable forms.

The synthetic forms in `forms.py` are drawn from scratch and look like no real form. A
pipeline that reads them proves it runs; it does not prove it can read a W-2 the way an
employer prints one. These fixtures fill the official IRS PDFs — public US government
works, downloaded from irs.gov and kept under `fixtures/irs/` — with invented data, flatten
the form fields into page content, and keep only the recipient copy (Copy B), which is the
page a client actually hands a preparer.

Every value is invented. The people are the same invented people as `forms.py`.

Field maps are keyed by the leaf of the AcroForm field name (`f2_09[0]`), which is unique
within a page. The maps were read off the PDFs with PyMuPDF; `_fill` asserts that every
name it is given exists on the page, so a revised IRS form that renumbers a field fails
loudly here rather than producing a fixture whose ground truth is wrong.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pymupdf

from draw import LETTER

IRS_DIR = Path(__file__).parent / "irs"

GroundTruth = dict[str, Any]


def _money(cents: int | None) -> str | None:
    """As a filer prints it: 85000.00 → "85,000.00". Never "$"; the IRS form prints that."""
    if cents is None:
        return None
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100:,}.{cents % 100:02d}"


def _copy_b_page(doc: pymupdf.Document) -> int:
    """Index of the recipient copy: the first page whose text says Copy B and carries widgets."""
    for index, page in enumerate(doc):
        text = " ".join(page.get_text("text").split())
        if "Copy B" in text and any(True for _ in page.widgets()):
            return index
    raise RuntimeError("no Copy B page with form fields")


def _fill(page: pymupdf.Page, values: dict[str, str | bool | None]) -> None:
    widgets = {w.field_name.split(".")[-1]: w for w in page.widgets()}
    missing = [leaf for leaf in values if leaf not in widgets]
    if missing:
        raise RuntimeError(f"form fields not found on page: {missing}; have {sorted(widgets)[:12]}…")
    for leaf, value in values.items():
        if value is None:
            continue
        widget = widgets[leaf]
        if widget.field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
            if value:
                widget.field_value = widget.on_state()
            else:
                continue
        else:
            widget.field_value = str(value)
            # Right-align money in its box the way payroll software does; harmless on text.
            if any(ch.isdigit() for ch in str(value)) and "," in str(value):
                widget.text_fontsize = 8
        widget.update()


def _flatten_copy_b(source: Path, values: dict[str, str | bool | None]) -> pymupdf.Document:
    """Fill the recipient copy and return a one-page document with the fields baked in."""
    src = pymupdf.open(str(source))
    index = _copy_b_page(src)
    _fill(src[index], values)
    src.bake()  # widgets become ordinary page content, exactly as a printed form would be
    out = pymupdf.open()
    out.insert_pdf(src, from_page=index, to_page=index)
    src.close()
    return out


def _assert_printed(doc: pymupdf.Document, expected: list[str]) -> None:
    """Every value we filled must be in the flattened text layer, or the fixture is a lie."""
    text = " ".join(doc[0].get_text("text").split())
    missing = [v for v in expected if v not in text]
    if missing:
        raise RuntimeError(f"filled values missing from flattened page text: {missing}")


# ── W-2 ──────────────────────────────────────────────────────────────────────

def w2(
    *,
    employee: dict[str, str],
    employee_address: tuple[str, str],
    employer: str,
    employer_address: tuple[str, str],
    employer_ein: str,
    box1: int,
    box2: int,
    box3: int | None,
    box4: int | None,
    box5: int | None,
    box6: int | None,
    box7: int | None = None,
    box8: int | None = None,
    box10: int | None = None,
    box12: list[tuple[str, int]] | None = None,
    retirement_plan: bool = False,
    box14: str | None = None,
    state: str | None = None,
    state_id: str | None = None,
    box16: int | None = None,
    box17: int | None = None,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    first, last = employee["name"].rsplit(" ", 1)
    codes = box12 or []
    values: dict[str, str | bool | None] = {
        "f2_01[0]": employee["tin"],
        "f2_02[0]": employer_ein,
        "f2_03[0]": f"{employer}\n{employer_address[0]}\n{employer_address[1]}",
        "f2_05[0]": first,
        "f2_06[0]": last,
        "f2_08[0]": f"{employee_address[0]}\n{employee_address[1]}",
        "f2_09[0]": _money(box1),
        "f2_10[0]": _money(box2),
        "f2_11[0]": _money(box3),
        "f2_12[0]": _money(box4),
        "f2_13[0]": _money(box5),
        "f2_14[0]": _money(box6),
        "f2_15[0]": _money(box7),
        "f2_16[0]": _money(box8),
        "f2_18[0]": _money(box10),
        "c2_3[0]": retirement_plan,
        "f2_28[0]": box14,
        "f2_29[0]": state,
        "f2_30[0]": state_id,
        "f2_33[0]": _money(box16),
        "f2_35[0]": _money(box17),
    }
    for slot, (code_leaf, amount_leaf) in enumerate([("f2_20[0]", "f2_21[0]"), ("f2_22[0]", "f2_23[0]"), ("f2_24[0]", "f2_25[0]"), ("f2_26[0]", "f2_27[0]")]):
        if slot < len(codes):
            values[code_leaf] = codes[slot][0]
            values[amount_leaf] = _money(codes[slot][1])

    doc = _flatten_copy_b(IRS_DIR / "fw2--2025.pdf", values)
    _assert_printed(doc, [v for v in [_money(box1), _money(box2), employer_ein, last] if v])

    truth = {
        "employer_name": employer,
        "employer_ein": employer_ein,
        "employee_name": employee["name"],
        "box_1": box1,
        "box_2": box2,
        "box_3": box3,
        "box_4": box4,
        "box_5": box5,
        "box_6": box6,
        "box_7": box7,
        "box_8": box8,
        "box_10": box10,
        "box_11": None,
        "box_13_retirement": retirement_plan,
        "box_14_other": box14,
        "box_15_state": state,
        "box_15_state_id": state_id,
        "box_16": box16,
        "box_17": box17,
    }
    for slot, letter in enumerate("abcd"):
        truth[f"box_12{letter}_code"] = codes[slot][0] if slot < len(codes) else None
        truth[f"box_12{letter}_amount"] = codes[slot][1] if slot < len(codes) else None

    return doc, {"file": filename, "page": 1, "formType": "W-2", "taxYear": 2025, "fields": truth}


def three_copies_on_one_page(single: pymupdf.Document) -> pymupdf.Document:
    """Copy B, Copy C and Copy 2 stacked on one letter page, as payroll vendors print them.

    The form area of the IRS page is its top third; the rest is instructions. Three clips of
    that area on one page gives the binder three identical readings of every box, which is
    what an employer-issued W-2 looks like and what rule 6 of the binder prompt is for.
    """
    out = pymupdf.open()
    page = out.new_page(width=LETTER.width, height=LETTER.height)
    clip = pymupdf.Rect(28, 18, 586, 346)
    slot_h = (LETTER.height - 40) / 3
    for i in range(3):
        target = pymupdf.Rect(20, 20 + i * slot_h, LETTER.width - 20, 20 + (i + 1) * slot_h - 8)
        page.show_pdf_page(target, single, 0, clip=clip)
    return out


# ── continuous-use 1099s and 1098 ────────────────────────────────────────────

def _payer_block(name: str, address: tuple[str, str], phone: str) -> str:
    return f"{name}\n{address[0]}\n{address[1]}\n{phone}"


def form_1099_int(
    *,
    payer: str,
    payer_address: tuple[str, str],
    payer_tin: str,
    recipient: dict[str, str],
    recipient_address: tuple[str, str],
    account: str,
    box1: int,
    box2: int | None = None,
    box3: int | None = None,
    box4: int | None = None,
    box8: int | None = None,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    values: dict[str, str | bool | None] = {
        "f2_1[0]": _payer_block(payer, payer_address, "(417) 555-0100"),
        "f2_2[0]": payer_tin,
        "f2_3[0]": recipient["tin"],
        "f2_4[0]": recipient["name"],
        "f2_5[0]": recipient_address[0],
        "f2_6[0]": recipient_address[1],
        "f2_7[0]": account,
        "f2_9[0]": _money(box1),
        "f2_10[0]": _money(box2),
        "f2_11[0]": _money(box3),
        "f2_12[0]": _money(box4),
        "f2_16[0]": _money(box8),
    }
    doc = _flatten_copy_b(IRS_DIR / "f1099int.pdf", values)
    _year_stamp(doc, "25")
    _assert_printed(doc, [_money(box1), payer_tin, recipient["name"]])  # type: ignore[list-item]
    truth = {
        "payer_name": payer, "payer_tin": payer_tin, "recipient_name": recipient["name"],
        "account_number": account, "corrected": False,
        "box_1": box1, "box_2": box2, "box_3": box3, "box_4": box4, "box_5": None, "box_6": None, "box_8": box8,
    }
    return doc, {"file": filename, "page": 1, "formType": "1099-INT", "taxYear": 2025, "fields": truth}


def form_1099_div(
    *,
    payer: str,
    payer_address: tuple[str, str],
    payer_tin: str,
    recipient: dict[str, str],
    recipient_address: tuple[str, str],
    account: str,
    box1a: int,
    box1b: int | None,
    box2a: int | None,
    box4: int | None = None,
    box5: int | None = None,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    values: dict[str, str | bool | None] = {
        "f2_2[0]": _payer_block(payer, payer_address, "(417) 555-0100"),
        "f2_3[0]": payer_tin,
        "f2_4[0]": recipient["tin"],
        "f2_5[0]": recipient["name"],
        "f2_6[0]": recipient_address[0],
        "f2_7[0]": recipient_address[1],
        "f2_8[0]": account,
        "f2_9[0]": _money(box1a),
        "f2_10[0]": _money(box1b),
        "f2_11[0]": _money(box2a),
        "f2_18[0]": _money(box4),
        "f2_19[0]": _money(box5),
    }
    doc = _flatten_copy_b(IRS_DIR / "f1099div.pdf", values)
    _year_stamp(doc, "25")
    _assert_printed(doc, [_money(box1a), payer_tin, recipient["name"]])  # type: ignore[list-item]
    truth = {
        "payer_name": payer, "payer_tin": payer_tin, "recipient_name": recipient["name"],
        "account_number": account, "corrected": False,
        "box_1a": box1a, "box_1b": box1b, "box_2a": box2a, "box_2b": None, "box_3": None,
        "box_4": box4, "box_5": box5, "box_12": None,
    }
    return doc, {"file": filename, "page": 1, "formType": "1099-DIV", "taxYear": 2025, "fields": truth}


def form_1099_r(
    *,
    payer: str,
    payer_address: tuple[str, str],
    payer_tin: str,
    recipient: dict[str, str],
    recipient_address: tuple[str, str],
    account: str,
    box1: int,
    box2a: int | None,
    taxable_not_determined: bool,
    total_distribution: bool,
    box4: int | None,
    box7_code: str,
    ira_sep_simple: bool,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    values: dict[str, str | bool | None] = {
        "f2_01[0]": _payer_block(payer, payer_address, "(800) 555-0142"),
        "f2_02[0]": payer_tin,
        "f2_03[0]": recipient["tin"],
        "f2_04[0]": recipient["name"],
        "f2_05[0]": recipient_address[0],
        "f2_06[0]": recipient_address[1],
        "f2_07[0]": account,
        "f2_08[0]": _money(box1),
        "f2_09[0]": _money(box2a),
        "c2_2[0]": taxable_not_determined,
        "c2_3[0]": total_distribution,
        "f2_11[0]": _money(box4),
        "f2_14[0]": box7_code,
        "c2_4[0]": ira_sep_simple,
    }
    doc = _flatten_copy_b(IRS_DIR / "f1099r--2025.pdf", values)
    _assert_printed(doc, [_money(box1), payer_tin, recipient["name"]])  # type: ignore[list-item]
    truth = {
        "payer_name": payer, "payer_tin": payer_tin, "recipient_name": recipient["name"],
        "account_number": account, "corrected": False,
        "box_1": box1, "box_2a": box2a,
        "box_2b_not_determined": taxable_not_determined, "box_2b_total_distribution": total_distribution,
        "box_3": None, "box_4": box4, "box_5": None, "box_6": None,
        "box_7_code": box7_code, "box_7_ira_sep_simple": ira_sep_simple,
    }
    return doc, {"file": filename, "page": 1, "formType": "1099-R", "taxYear": 2025, "fields": truth}


def form_1098(
    *,
    lender: str,
    lender_address: tuple[str, str],
    lender_tin: str,
    borrower: dict[str, str],
    borrower_address: tuple[str, str],
    account: str,
    box1: int,
    box2: int | None,
    box3: str | None,
    box4: int | None = None,
    box5: int | None = None,
    box6: int | None = None,
    box9: int | None = None,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    values: dict[str, str | bool | None] = {
        "f2_1[0]": "25",
        "f2_2[0]": _payer_block(lender, lender_address, "(800) 555-0177"),
        "f2_3[0]": lender_tin,
        "f2_4[0]": borrower["tin"],
        "f2_5[0]": borrower["name"],
        "f2_6[0]": borrower_address[0],
        "f2_7[0]": borrower_address[1],
        "f2_10[0]": account,
        "f2_11[0]": _money(box1),
        "f2_12[0]": _money(box2),
        "f2_13[0]": box3,
        "f2_14[0]": _money(box4),
        "f2_15[0]": _money(box5),
        "f2_16[0]": _money(box6),
        "f2_8[0]": str(box9) if box9 is not None else None,
    }
    doc = _flatten_copy_b(IRS_DIR / "f1098--2025.pdf", values)
    _assert_printed(doc, [_money(box1), lender_tin, borrower["name"]])  # type: ignore[list-item]
    truth = {
        "recipient_name": lender, "payer_tin": lender_tin, "borrower_name": borrower["name"],
        "corrected": False,
        "box_1": box1, "box_2": box2, "box_3": box3, "box_4": box4, "box_5": box5, "box_6": box6,
        "box_9": box9,
    }
    return doc, {"file": filename, "page": 1, "formType": "1098", "taxYear": 2025, "fields": truth}


def form_1099_nec(
    *,
    payer: str,
    payer_address: tuple[str, str],
    payer_tin: str,
    recipient: dict[str, str],
    recipient_address: tuple[str, str],
    box1: int,
    box4: int | None = None,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    values: dict[str, str | bool | None] = {
        "f2_1[0]": "25",
        "f2_2[0]": _payer_block(payer, payer_address, "(417) 555-0133"),
        "f2_3[0]": payer_tin,
        "f2_4[0]": recipient["tin"],
        "f2_5[0]": recipient["name"],
        "f2_6[0]": recipient_address[0],
        "f2_7[0]": recipient_address[1],
        "f2_9[0]": _money(box1),
        "f2_11[0]": _money(box4),
    }
    doc = _flatten_copy_b(IRS_DIR / "f1099nec--2025.pdf", values)
    _assert_printed(doc, [_money(box1), payer_tin, recipient["name"]])  # type: ignore[list-item]
    truth = {
        "payer_name": payer, "payer_tin": payer_tin, "recipient_name": recipient["name"],
        "corrected": False, "box_1": box1, "box_2": False, "box_4": box4, "box_5": None,
    }
    return doc, {"file": filename, "page": 1, "formType": "1099-NEC", "taxYear": 2025, "fields": truth}


def form_1099_misc(
    *,
    payer: str,
    payer_address: tuple[str, str],
    payer_tin: str,
    recipient: dict[str, str],
    recipient_address: tuple[str, str],
    box1: int | None,
    box2: int | None = None,
    box3: int | None = None,
    box4: int | None = None,
    filename: str,
) -> tuple[pymupdf.Document, GroundTruth]:
    values: dict[str, str | bool | None] = {
        "f2_1[0]": "25",
        "f2_2[0]": _payer_block(payer, payer_address, "(417) 555-0188"),
        "f2_3[0]": payer_tin,
        "f2_4[0]": recipient["tin"],
        "f2_5[0]": recipient["name"],
        "f2_6[0]": recipient_address[0],
        "f2_7[0]": recipient_address[1],
        "f2_9[0]": _money(box1),
        "f2_10[0]": _money(box2),
        "f2_11[0]": _money(box3),
        "f2_12[0]": _money(box4),
    }
    doc = _flatten_copy_b(IRS_DIR / "f1099msc--2025.pdf", values)
    _assert_printed(doc, [v for v in [_money(box1), _money(box3), payer_tin] if v])
    truth = {
        "payer_name": payer, "payer_tin": payer_tin, "recipient_name": recipient["name"],
        "corrected": False,
        "box_1": box1, "box_2": box2, "box_3": box3, "box_4": box4, "box_5": None, "box_6": None,
    }
    return doc, {"file": filename, "page": 1, "formType": "1099-MISC", "taxYear": 2025, "fields": truth}


def _year_stamp(doc: pymupdf.Document, yy: str) -> None:
    """Continuous-use 1099-INT/DIV print "For calendar year 20__"; the widget leaf differs per
    form, so the two digits are written into the first calendar-year widget after the bake
    is already done — as plain text at the same spot."""
    page = doc[0]
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        if word == "20" and 400 < x0 < 470 and 90 < y0 < 110:
            page.insert_text((x1 + 1, y1 - 1), yy, fontsize=8, fontname="helv")
            return


# ── non-form pages every real packet contains ────────────────────────────────

def cover_letter(*, client: str, firm: str, filename: str) -> tuple[pymupdf.Document, GroundTruth]:
    doc = pymupdf.open()
    page = doc.new_page(width=LETTER.width, height=LETTER.height)
    y = 90.0
    for line in [
        firm,
        "Certified Public Accountants",
        "",
        "February 12, 2026",
        "",
        f"Dear {client},",
        "",
        "Enclosed are the tax documents you provided for the preparation of your 2025",
        "individual income tax return. Please review the list below and let us know if",
        "anything is missing. Forms W-2, 1099 and 1098 are included in this packet.",
        "",
        "Sincerely,",
        "",
        "Client Services",
    ]:
        page.insert_text((72, y), line, fontsize=10, fontname="helv")
        y += 15
    return doc, {"file": filename, "page": 1, "formType": None, "taxYear": 2025, "isSupplemental": True, "fields": {}}


def blank_page(*, filename: str) -> tuple[pymupdf.Document, GroundTruth]:
    """The back side of a duplex scan. Zero text, zero spans, and it must not stall a bundle."""
    doc = pymupdf.open()
    doc.new_page(width=LETTER.width, height=LETTER.height)
    return doc, {
        "file": filename, "page": 1, "formType": None, "taxYear": None,
        "isSupplemental": True, "expectedRoute": "raster", "expectedSpanCount": 0, "fields": {},
    }
