"""Synthetic tax forms, each returning (document, ground_truth).

Ground truth is the point. A fixture without expected values only proves the pipeline runs;
a fixture with them proves it got the right answer, which is what every "on a fixture set"
exit criterion in PHASES.md is actually asking for.

All data is invented. TINs are shape-valid so identity resolution exercises properly, and
one taxpayer deliberately carries an **ITIN** (9xx area) because that path silently dropped
a spouse before it was fixed.
"""
from __future__ import annotations

from typing import Any

import pymupdf

from draw import (
    FONT,
    FONT_BOLD,
    GREY,
    LETTER,
    MARGIN,
    Box,
    FormPage,
    add_page,
    grid,
    money,
    new_doc,
    party_block,
    printed_zero,
)

GroundTruth = dict[str, Any]

# ── invented people ──────────────────────────────────────────────────────────

ROBERT = {"name": "ROBERT J SMITH", "tin": "123-45-6789", "last4": "6789"}
# ITIN: 9xx area with an assigned group (70-88). Exercises the ITIN path.
MARIA = {"name": "MARIA L SMITH", "tin": "912-70-5544", "last4": "5544"}
TRUST = {"name": "SMITH FAMILY TRUST", "tin": "123-45-6789", "last4": "6789"}


def _doc_truth(
    file: str, page: int, form_type: str, tax_year: int, fields: dict[str, int | str | bool | None]
) -> GroundTruth:
    return {"file": file, "page": page, "formType": form_type, "taxYear": tax_year, "fields": fields}


# ── W-2 ──────────────────────────────────────────────────────────────────────

def w2(
    *,
    employee: dict[str, str],
    employer: str,
    employer_ein: str,
    box1: int,
    box2: int,
    box3: int | None,
    box4: int | None,
    box5: int | None,
    box6: int | None,
    box12: list[tuple[str, int]] | None = None,
    box16: int | None = None,
    box17: int | None = None,
    tax_year: int = 2025,
    retirement_plan: bool = True,
    filename: str = "w2.pdf",
) -> tuple[pymupdf.Document, GroundTruth]:
    doc = new_doc()
    box12 = box12 or []

    entries: list[tuple[str, str, str | None]] = [
        ("1", "Wages, tips, other compensation", money(box1)),
        ("2", "Federal income tax withheld", money(box2)),
        ("3", "Social security wages", money(box3)),
        ("4", "Social security tax withheld", money(box4)),
        ("5", "Medicare wages and tips", money(box5)),
        ("6", "Medicare tax withheld", money(box6)),
        # Blank on purpose: the extractor must return null, not 0.
        ("7", "Social security tips", None),
        # A printed zero, on purpose: the extractor must return 0, not null.
        ("8", "Allocated tips", printed_zero()),
        ("10", "Dependent care benefits", None),
        ("11", "Nonqualified plans", None),
    ]

    page = FormPage(
        title="Form W-2  Wage and Tax Statement",
        subtitle="Copy B — To Be Filed With Employee's FEDERAL Tax Return",
        year=tax_year,
        boxes=grid(entries, top=150.0),
    )

    # Box 12 rows, each a code + amount pair.
    y = 150.0 + 5 * 36.0 + 6
    for index, (code, amount) in enumerate(box12):
        letter = "abcd"[index]
        page.boxes.append(
            Box(
                label=f"See instructions for box 12",
                value=f"{code}   {money(amount)}",
                x=MARGIN,
                y=y + index * 22,
                w=240,
                h=20,
                box_id=f"12{letter}",
            )
        )

    page.checkboxes = [
        ("Statutory employee", MARGIN + 260, y + 4, False),
        ("Retirement plan", MARGIN + 260, y + 18, retirement_plan),
        ("Third-party sick pay", MARGIN + 260, y + 32, False),
    ]

    if box16 is not None:
        page.boxes.append(Box("State wages, tips, etc.", money(box16), MARGIN, y + 76, 180, 26, box_id="16"))
        page.boxes.append(Box("State income tax", money(box17), MARGIN + 190, y + 76, 180, 26, box_id="17"))
        page.boxes.append(Box("State", "MO", MARGIN + 380, y + 76, 100, 26, box_id="15"))

    page.notes = ["Synthetic fixture. Not a real Form W-2. All identifiers are invented."]
    p = add_page(doc, page)
    party_block(
        p,
        left_title="c  Employer's name, address, and ZIP code",
        left_lines=[employer, "1400 INDUSTRIAL PKWY", "MONETT, MO 65708", f"EIN {employer_ein}"],
        right_title="e  Employee's name, address, and ZIP code",
        right_lines=[employee["name"], "802 CEDAR ST", "MONETT, MO 65708", f"SSN {employee['tin']}"],
    )

    fields: dict[str, int | str | bool | None] = {
        "box_1": box1,
        "box_2": box2,
        "box_3": box3,
        "box_4": box4,
        "box_5": box5,
        "box_6": box6,
        "box_7": None,
        "box_8": 0,
        "box_10": None,
        "box_11": None,
        "box_13_retirement": retirement_plan,
        "employer_name": employer,
        "employer_ein": employer_ein,
    }
    for index, (code, amount) in enumerate(box12):
        letter = "abcd"[index]
        fields[f"box_12{letter}_code"] = code
        fields[f"box_12{letter}_amount"] = amount
    if box16 is not None:
        fields["box_16"] = box16
        fields["box_17"] = box17

    return doc, _doc_truth(filename, 1, "W-2", tax_year, fields)


# ── 1099-INT / DIV / B ───────────────────────────────────────────────────────

def _payer_recipient(p: pymupdf.Page, payer: str, payer_tin: str, recipient: dict[str, str], account: str) -> None:
    party_block(
        p,
        left_title="PAYER'S name, street address, city, state, ZIP",
        left_lines=[payer, "500 MARKET ST", "ST LOUIS, MO 63101", f"TIN {payer_tin}"],
        right_title="RECIPIENT'S name and address",
        right_lines=[recipient["name"], "802 CEDAR ST", "MONETT, MO 65708", f"TIN {recipient['tin']}"],
    )
    p.insert_text((MARGIN, 146), f"Account number: {account}", fontname=FONT, fontsize=7, color=GREY)


def form_1099_int(
    *,
    payer: str,
    payer_tin: str,
    recipient: dict[str, str],
    account: str,
    box1: int,
    box4: int | None = None,
    box8: int | None = None,
    corrected: bool = False,
    tax_year: int = 2025,
    filename: str = "1099-int.pdf",
    page_number: int = 1,
    doc: pymupdf.Document | None = None,
) -> tuple[pymupdf.Document, GroundTruth]:
    doc = doc or new_doc()
    entries = [
        ("1", "Interest income", money(box1)),
        ("2", "Early withdrawal penalty", None),
        ("3", "Interest on U.S. Savings Bonds and Treasury obligations", None),
        ("4", "Federal income tax withheld", money(box4)),
        ("5", "Investment expenses", None),
        ("8", "Tax-exempt interest", money(box8)),
    ]
    page = FormPage(
        title="Form 1099-INT  Interest Income",
        subtitle="Copy B — For Recipient",
        year=tax_year,
        boxes=grid(entries, top=160.0),
        checkboxes=[("CORRECTED (if checked)", MARGIN + 380, 100, corrected)],
        notes=["Synthetic fixture. Not a real Form 1099-INT."],
    )
    p = add_page(doc, page)
    _payer_recipient(p, payer, payer_tin, recipient, account)

    return doc, _doc_truth(
        filename,
        page_number,
        "1099-INT",
        tax_year,
        {
            "box_1": box1,
            "box_2": None,
            "box_3": None,
            "box_4": box4,
            "box_5": None,
            "box_8": box8,
            "corrected": corrected,
            "payer_name": payer,
        },
    )


def form_1099_div(
    *,
    payer: str,
    payer_tin: str,
    recipient: dict[str, str],
    account: str,
    box1a: int,
    box1b: int,
    box2a: int | None = None,
    box4: int | None = None,
    tax_year: int = 2025,
    filename: str = "1099-div.pdf",
    page_number: int = 1,
    doc: pymupdf.Document | None = None,
) -> tuple[pymupdf.Document, GroundTruth]:
    doc = doc or new_doc()
    entries = [
        ("1a", "Total ordinary dividends", money(box1a)),
        ("1b", "Qualified dividends", money(box1b)),
        ("2a", "Total capital gain distributions", money(box2a)),
        ("2b", "Unrecaptured Section 1250 gain", None),
        ("3", "Nondividend distributions", None),
        ("4", "Federal income tax withheld", money(box4)),
        ("5", "Section 199A dividends", None),
        ("12", "Exempt-interest dividends", None),
    ]
    page = FormPage(
        title="Form 1099-DIV  Dividends and Distributions",
        subtitle="Copy B — For Recipient",
        year=tax_year,
        boxes=grid(entries, top=160.0),
        notes=["Synthetic fixture. Not a real Form 1099-DIV."],
    )
    p = add_page(doc, page)
    _payer_recipient(p, payer, payer_tin, recipient, account)

    return doc, _doc_truth(
        filename,
        page_number,
        "1099-DIV",
        tax_year,
        {
            "box_1a": box1a,
            "box_1b": box1b,
            "box_2a": box2a,
            "box_2b": None,
            "box_3": None,
            "box_4": box4,
            "box_5": None,
            "box_12": None,
            "payer_name": payer,
        },
    )


def form_1099_b_section(
    *,
    payer: str,
    payer_tin: str,
    recipient: dict[str, str],
    account: str,
    section_code: str,
    rows: list[tuple[str, str, str, int, int | None]],
    tax_year: int = 2025,
    filename: str = "1099-b.pdf",
    page_number: int = 1,
    doc: pymupdf.Document | None = None,
    noncovered: bool = False,
) -> tuple[pymupdf.Document, GroundTruth]:
    """One 1099-B section page: a table of dispositions plus its own subtotal."""
    doc = doc or new_doc()
    p = doc.new_page(width=LETTER.width, height=LETTER.height)

    p.insert_text((MARGIN, MARGIN + 10), "Form 1099-B  Proceeds From Broker Transactions",
                  fontname=FONT_BOLD, fontsize=13)
    p.insert_text((LETTER.width - MARGIN - 70, MARGIN + 10), str(tax_year), fontname=FONT_BOLD, fontsize=16)
    p.insert_text((MARGIN, MARGIN + 24),
                  f"Section {section_code} — " +
                  ("Short-term, basis NOT reported to IRS" if noncovered else "Short-term, basis reported to IRS"),
                  fontname=FONT, fontsize=8, color=GREY)
    p.draw_line(pymupdf.Point(MARGIN, MARGIN + 32), pymupdf.Point(LETTER.width - MARGIN, MARGIN + 32), width=1.1)

    _payer_recipient(p, payer, payer_tin, recipient, account)

    headers = ["1a Description", "1b Acquired", "1c Sold", "1d Proceeds", "1e Cost basis"]
    xs = [MARGIN, MARGIN + 170, MARGIN + 240, MARGIN + 320, MARGIN + 420]
    y = 172.0
    for x, h in zip(xs, headers):
        p.insert_text((x, y), h, fontname=FONT_BOLD, fontsize=7)
    y += 6
    p.draw_line(pymupdf.Point(MARGIN, y), pymupdf.Point(LETTER.width - MARGIN, y), width=0.6)
    y += 12

    proceeds_total = 0
    basis_total = 0
    basis_missing = False
    for desc, acquired, sold, proceeds, basis in rows:
        p.insert_text((xs[0], y), desc, fontname=FONT, fontsize=8)
        p.insert_text((xs[1], y), acquired, fontname=FONT, fontsize=8)
        p.insert_text((xs[2], y), sold, fontname=FONT, fontsize=8)
        p.insert_text((xs[3], y), money(proceeds) or "", fontname=FONT, fontsize=8)
        # A noncovered lot prints nothing in 1e. That blank is a Judgment Required trigger.
        p.insert_text((xs[4], y), money(basis) or "", fontname=FONT, fontsize=8)
        proceeds_total += proceeds
        if basis is None:
            basis_missing = True
        else:
            basis_total += basis
        y += 14

    y += 6
    p.draw_line(pymupdf.Point(MARGIN, y), pymupdf.Point(LETTER.width - MARGIN, y), width=0.8)
    y += 14
    p.insert_text((xs[2], y), "Section subtotal", fontname=FONT_BOLD, fontsize=8)
    p.insert_text((xs[3], y), money(proceeds_total) or "", fontname=FONT_BOLD, fontsize=8)
    p.insert_text((xs[4], y), (money(basis_total) if not basis_missing else ""), fontname=FONT_BOLD, fontsize=8)

    p.insert_text((MARGIN, LETTER.height - MARGIN),
                  "Synthetic fixture. Not a real Form 1099-B.", fontname=FONT, fontsize=6.5, color=GREY)

    return doc, _doc_truth(
        filename,
        page_number,
        "1099-B",
        tax_year,
        {
            "section_code": section_code,
            "summary_total_proceeds": proceeds_total,
            "summary_total_cost_basis": None if basis_missing else basis_total,
            "box_5_noncovered": noncovered,
            "payer_name": payer,
        },
    )


# ── 1099-R ───────────────────────────────────────────────────────────────────

def form_1099_r(
    *,
    payer: str,
    payer_tin: str,
    recipient: dict[str, str],
    box1: int,
    box2a: int | None,
    box4: int | None,
    code: str,
    ira_sep_simple: bool,
    taxable_not_determined: bool = False,
    tax_year: int = 2025,
    filename: str = "1099-r.pdf",
) -> tuple[pymupdf.Document, GroundTruth]:
    doc = new_doc()
    entries = [
        ("1", "Gross distribution", money(box1)),
        ("2a", "Taxable amount", money(box2a)),
        ("3", "Capital gain (included in box 2a)", None),
        ("4", "Federal income tax withheld", money(box4)),
        ("5", "Employee contributions / Roth contributions", None),
        ("6", "Net unrealized appreciation", None),
        ("7", "Distribution code(s)", code),
        ("9b", "Total employee contributions", None),
    ]
    page = FormPage(
        title="Form 1099-R  Distributions From Pensions, Annuities, Retirement Plans, IRAs",
        subtitle="Copy B — Report this income on your federal tax return",
        year=tax_year,
        boxes=grid(entries, top=160.0),
        checkboxes=[
            ("2b Taxable amount not determined", MARGIN, 340, taxable_not_determined),
            ("2b Total distribution", MARGIN, 354, True),
            ("7 IRA/SEP/SIMPLE", MARGIN + 280, 340, ira_sep_simple),
        ],
        notes=["Synthetic fixture. Not a real Form 1099-R."],
    )
    p = add_page(doc, page)
    _payer_recipient(p, payer, payer_tin, recipient, "RET-40021")

    return doc, _doc_truth(
        filename,
        1,
        "1099-R",
        tax_year,
        {
            "box_1": box1,
            "box_2a": box2a,
            "box_2b_not_determined": taxable_not_determined,
            "box_3": None,
            "box_4": box4,
            "box_5": None,
            "box_7_code": code,
            "box_7_ira_sep_simple": ira_sep_simple,
            "payer_name": payer,
        },
    )


# ── 1095-A ───────────────────────────────────────────────────────────────────

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]


def form_1095_a(
    *,
    recipient: dict[str, str],
    monthly_premium: int,
    monthly_slcsp: int,
    monthly_aptc: int,
    tax_year: int = 2025,
    filename: str = "1095-a.pdf",
    break_footing: bool = False,
) -> tuple[pymupdf.Document, GroundTruth]:
    """Full-year coverage. `break_footing` makes the annual row disagree — a hard failure."""
    doc = new_doc()
    p = doc.new_page(width=LETTER.width, height=LETTER.height)

    p.insert_text((MARGIN, MARGIN + 10), "Form 1095-A  Health Insurance Marketplace Statement",
                  fontname=FONT_BOLD, fontsize=13)
    p.insert_text((LETTER.width - MARGIN - 70, MARGIN + 10), str(tax_year), fontname=FONT_BOLD, fontsize=16)
    p.draw_line(pymupdf.Point(MARGIN, MARGIN + 32), pymupdf.Point(LETTER.width - MARGIN, MARGIN + 32), width=1.1)

    p.insert_text((MARGIN, 82), "Part I — Recipient Information", fontname=FONT_BOLD, fontsize=9)
    p.insert_text((MARGIN, 96), f"2  Marketplace-assigned policy number: MO-2200041", fontname=FONT, fontsize=8)
    p.insert_text((MARGIN, 108), f"3  Recipient's name: {recipient['name']}", fontname=FONT, fontsize=8)
    p.insert_text((MARGIN, 120), f"4  Recipient's SSN: {recipient['tin']}", fontname=FONT, fontsize=8)

    p.insert_text((MARGIN, 150), "Part III — Coverage Information", fontname=FONT_BOLD, fontsize=9)
    xs = [MARGIN, MARGIN + 160, MARGIN + 290, MARGIN + 420]
    y = 168.0
    for x, h in zip(xs, ["Month", "A. Monthly premium", "B. SLCSP premium", "C. Monthly APTC"]):
        p.insert_text((x, y), h, fontname=FONT_BOLD, fontsize=7)
    y += 6
    p.draw_line(pymupdf.Point(MARGIN, y), pymupdf.Point(LETTER.width - MARGIN, y), width=0.6)
    y += 12

    for index, month in enumerate(MONTHS):
        p.insert_text((xs[0], y), f"{21 + index}  {month}", fontname=FONT, fontsize=8)
        p.insert_text((xs[1], y), money(monthly_premium) or "", fontname=FONT, fontsize=8)
        p.insert_text((xs[2], y), money(monthly_slcsp) or "", fontname=FONT, fontsize=8)
        p.insert_text((xs[3], y), money(monthly_aptc) or "", fontname=FONT, fontsize=8)
        y += 14

    annual_premium = monthly_premium * 12 + (5000 if break_footing else 0)
    annual_slcsp = monthly_slcsp * 12
    annual_aptc = monthly_aptc * 12

    y += 4
    p.draw_line(pymupdf.Point(MARGIN, y), pymupdf.Point(LETTER.width - MARGIN, y), width=0.8)
    y += 14
    p.insert_text((xs[0], y), "33  Annual totals", fontname=FONT_BOLD, fontsize=8)
    p.insert_text((xs[1], y), money(annual_premium) or "", fontname=FONT_BOLD, fontsize=8)
    p.insert_text((xs[2], y), money(annual_slcsp) or "", fontname=FONT_BOLD, fontsize=8)
    p.insert_text((xs[3], y), money(annual_aptc) or "", fontname=FONT_BOLD, fontsize=8)

    p.insert_text((MARGIN, LETTER.height - MARGIN),
                  "Synthetic fixture. Not a real Form 1095-A.", fontname=FONT, fontsize=6.5, color=GREY)

    fields: dict[str, int | str | bool | None] = {
        "annual_premium": annual_premium,
        "annual_slcsp": annual_slcsp,
        "annual_aptc": annual_aptc,
    }
    for month in MONTHS:
        key = month.lower()
        fields[f"monthly_{key}_premium"] = monthly_premium
        fields[f"monthly_{key}_slcsp"] = monthly_slcsp
        fields[f"monthly_{key}_aptc"] = monthly_aptc

    truth = _doc_truth(filename, 1, "1095-A", tax_year, fields)
    truth["expectedHardFailure"] = "a1095_monthly_rows_foot_to_annual:premium" if break_footing else None
    return doc, truth


# ── 1098 ─────────────────────────────────────────────────────────────────────

def form_1098(
    *,
    lender: str,
    borrower: dict[str, str],
    box1: int,
    box2: int,
    box6: int | None = None,
    tax_year: int = 2025,
    filename: str = "1098.pdf",
) -> tuple[pymupdf.Document, GroundTruth]:
    doc = new_doc()
    entries = [
        ("1", "Mortgage interest received from payer(s)/borrower(s)", money(box1)),
        ("2", "Outstanding mortgage principal", money(box2)),
        ("3", "Mortgage origination date", "03/14/2019"),
        ("4", "Refund of overpaid interest", None),
        ("5", "Mortgage insurance premiums", None),
        ("6", "Points paid on purchase of principal residence", money(box6)),
    ]
    page = FormPage(
        title="Form 1098  Mortgage Interest Statement",
        subtitle="Copy B — For Payer/Borrower",
        year=tax_year,
        boxes=grid(entries, top=160.0),
        notes=["Synthetic fixture. Not a real Form 1098."],
    )
    p = add_page(doc, page)
    party_block(
        p,
        left_title="RECIPIENT'S/LENDER'S name and address",
        left_lines=[lender, "77 BANK PLAZA", "SPRINGFIELD, MO 65806", "TIN 43-0999888"],
        right_title="PAYER'S/BORROWER'S name and address",
        right_lines=[borrower["name"], "802 CEDAR ST", "MONETT, MO 65708", f"TIN {borrower['tin']}"],
    )
    return doc, _doc_truth(
        filename, 1, "1098", tax_year,
        {"box_1": box1, "box_2": box2, "box_4": None, "box_5": None, "box_6": box6, "recipient_name": lender},
    )


# ── K-1 (1065) with a §199A footnote ─────────────────────────────────────────

def k1_1065(
    *,
    partnership: str,
    partner: dict[str, str],
    boxes: dict[int, int],
    rendering: str,
    tax_year: int = 2025,
    filename: str = "k1-1065.pdf",
) -> tuple[pymupdf.Document, GroundTruth]:
    """`rendering` mimics a tax package's house style — the three differ visibly (P15)."""
    doc = new_doc()
    p = doc.new_page(width=LETTER.width, height=LETTER.height)

    title_size = {"UltraTax": 12, "CCH": 13.5, "Lacerte": 11}.get(rendering, 12)
    p.insert_text((MARGIN, MARGIN + 10), "Schedule K-1 (Form 1065)", fontname=FONT_BOLD, fontsize=title_size)
    p.insert_text((MARGIN, MARGIN + 24), f"Partner's Share of Income, Deductions, Credits, etc.  [{rendering} rendering]",
                  fontname=FONT, fontsize=8, color=GREY)
    p.insert_text((LETTER.width - MARGIN - 70, MARGIN + 10), str(tax_year), fontname=FONT_BOLD, fontsize=16)
    p.draw_line(pymupdf.Point(MARGIN, MARGIN + 32), pymupdf.Point(LETTER.width - MARGIN, MARGIN + 32), width=1.1)

    party_block(
        p,
        left_title="Part I — Information About the Partnership",
        left_lines=[partnership, "EIN 43-1234567", "220 COMMERCE DR", "SPRINGFIELD, MO 65806"],
        right_title="Part II — Information About the Partner",
        right_lines=[partner["name"], f"TIN {partner['tin']}", "802 CEDAR ST", "MONETT, MO 65708"],
    )

    p.insert_text((MARGIN, 156), "Part III — Partner's Share of Current Year Income", fontname=FONT_BOLD, fontsize=9)
    y = 172.0
    # Lacerte-style renderings put the box column on the right; the others on the left.
    label_x = MARGIN + 260 if rendering == "Lacerte" else MARGIN
    value_x = MARGIN + 470 if rendering == "Lacerte" else MARGIN + 220

    box_labels = {
        1: "Ordinary business income (loss)",
        2: "Net rental real estate income (loss)",
        5: "Interest income",
        6: "Ordinary dividends",
        9: "Net long-term capital gain (loss)",
        20: "Other information",
    }
    for box_number in sorted(boxes):
        label = box_labels.get(box_number, f"Box {box_number}")
        p.insert_text((label_x, y), f"{box_number}   {label}", fontname=FONT, fontsize=8)
        value = "Z*  STMT" if box_number == 20 else (money(boxes[box_number]) or "")
        p.insert_text((value_x, y), value, fontname=FONT_BOLD, fontsize=8)
        y += 16

    p.insert_text((MARGIN, y + 18), "*See attached statement for additional information.",
                  fontname=FONT, fontsize=7.5, color=GREY)
    p.insert_text((MARGIN, LETTER.height - MARGIN),
                  "Synthetic fixture. Not a real Schedule K-1.", fontname=FONT, fontsize=6.5, color=GREY)

    # The §199A statement page — attached unparsed to the worksheet in v1 (§8).
    p2 = doc.new_page(width=LETTER.width, height=LETTER.height)
    p2.insert_text((MARGIN, MARGIN + 12), "Schedule K-1, Box 20, Code Z — Section 199A Information",
                   fontname=FONT_BOLD, fontsize=11)
    p2.insert_text((MARGIN, MARGIN + 28), f"{partnership}   Tax year {tax_year}", fontname=FONT, fontsize=8, color=GREY)
    lines = [
        "Trade or business:  SPRINGFIELD COMMERCE PARTNERS LP",
        "",
        f"  Ordinary business income (loss) .................. {money(boxes.get(1, 0))}",
        "  W-2 wages ......................................... 412,000.00",
        "  Unadjusted basis immediately after acquisition ..... 1,875,000.00",
        "  Section 199A REIT dividends ....................... -0-",
        "",
        "This statement is provided as a footnote and is not itself a numbered box.",
        "The preparer must read it; this app attaches it unparsed (CLAUDE.md §8).",
    ]
    y = 110.0
    for line in lines:
        p2.insert_text((MARGIN, y), line, fontname=FONT, fontsize=9)
        y += 14

    fields: dict[str, int | str | bool | None] = {f"box_{n}": v for n, v in boxes.items() if n != 20}
    fields["footnote_pages_present"] = True
    fields["box_20_code_z_statement_present"] = True

    truth = _doc_truth(filename, 1, "K-1-1065", tax_year, fields)
    truth["allJudgmentRequired"] = True
    truth["rendering"] = rendering
    truth["pages"] = 2
    return doc, truth
