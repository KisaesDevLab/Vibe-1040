"""Generate the synthetic fixture set.

    python fixtures/generate.py [output-dir]

Every document is invented. No client data, live or de-identified, goes anywhere near this
(CLAUDE.md fixture rule). Output is deterministic — same seed, same bytes — so a fixture
change shows up as a real diff rather than as noise.

The manifest is the important half: it records the expected value of every field, including
which boxes are **blank** versus which print a **zero**, so the extraction tests can assert
correctness rather than merely that something came back.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pymupdf  # noqa: E402

import forms  # noqa: E402
from degrade import phone_photo, scanned  # noqa: E402
from draw import FONT, FONT_BOLD, GREY, LETTER, MARGIN, money, new_doc  # noqa: E402
from forms import MARIA, ROBERT, TRUST  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "test/fixtures")


def consolidated_1099(
    *,
    brokerage: str,
    payer_tin: str,
    recipient: dict,
    account: str,
    interest: int,
    ordinary_div: int,
    qualified_div: int,
    cap_gain: int,
    b_rows: list,
    style: str,
    filename: str,
    break_tie: bool = False,
) -> tuple[pymupdf.Document, list[dict]]:
    """A consolidated brokerage package: summary page, sub-forms, supplemental pages.

    `style` varies the layout between brokerages, because P4's whole difficulty is that
    consolidated packages look nothing alike across firms. `break_tie` makes the summary
    disagree with its own sub-forms — the §6 hard failure.
    """
    doc = new_doc()
    truths: list[dict] = []

    # ── page 1: the package summary ──────────────────────────────────────────
    p = doc.new_page(width=LETTER.width, height=LETTER.height)
    p.insert_text((MARGIN, MARGIN + 12), f"{brokerage}", fontname=FONT_BOLD, fontsize=15)
    p.insert_text((MARGIN, MARGIN + 30),
                  "2025 Consolidated Forms 1099  —  Tax Reporting Statement",
                  fontname=FONT_BOLD if style == "dense" else FONT, fontsize=11)
    p.insert_text((MARGIN, MARGIN + 46), f"Account {account}    Recipient {recipient['name']}    TIN {recipient['tin']}",
                  fontname=FONT, fontsize=8, color=GREY)
    p.draw_line(pymupdf.Point(MARGIN, MARGIN + 56), pymupdf.Point(LETTER.width - MARGIN, MARGIN + 56), width=1.2)

    reported_interest = interest + (2500 if break_tie else 0)
    summary_rows = [
        ("1099-INT  Interest income", reported_interest),
        ("1099-DIV  Total ordinary dividends", ordinary_div),
        ("1099-DIV  Qualified dividends", qualified_div),
        ("1099-DIV  Total capital gain distributions", cap_gain),
        ("1099-B    Gross proceeds", sum(r[3] for section in b_rows for r in section["rows"])),
        ("Federal income tax withheld", 0),
    ]
    y = 120.0
    p.insert_text((MARGIN, y), "SUMMARY OF REPORTABLE AMOUNTS", fontname=FONT_BOLD, fontsize=9)
    y += 18
    for label, amount in summary_rows:
        p.insert_text((MARGIN + (14 if style == "indented" else 0), y), label, fontname=FONT, fontsize=9)
        p.insert_text((MARGIN + 360, y), money(amount) or "", fontname=FONT_BOLD, fontsize=9)
        y += 16

    p.insert_text((MARGIN, y + 24),
                  "Amounts above are summarized from the detail pages that follow.",
                  fontname=FONT, fontsize=7.5, color=GREY)
    p.insert_text((MARGIN, LETTER.height - MARGIN),
                  "Synthetic fixture. Not a real consolidated 1099.", fontname=FONT, fontsize=6.5, color=GREY)

    truths.append({
        "file": filename, "page": 1, "formType": "1099-CONSOLIDATED", "taxYear": 2025,
        "isSummary": True,
        "fields": {
            "summary_interest": reported_interest,
            "summary_ordinary_dividends": ordinary_div,
            "summary_qualified_dividends": qualified_div,
            "summary_capital_gain_distributions": cap_gain,
            "summary_proceeds": sum(r[3] for section in b_rows for r in section["rows"]),
            "summary_federal_withheld": 0,
            "payer_name": brokerage,
        },
    })

    # ── sub-forms ────────────────────────────────────────────────────────────
    _, t_int = forms.form_1099_int(
        payer=brokerage, payer_tin=payer_tin, recipient=recipient, account=account,
        box1=interest, filename=filename, page_number=2, doc=doc,
    )
    t_int["parentPage"] = 1
    truths.append(t_int)

    _, t_div = forms.form_1099_div(
        payer=brokerage, payer_tin=payer_tin, recipient=recipient, account=account,
        box1a=ordinary_div, box1b=qualified_div, box2a=cap_gain,
        filename=filename, page_number=3, doc=doc,
    )
    t_div["parentPage"] = 1
    truths.append(t_div)

    page_number = 4
    for section in b_rows:
        _, t_b = forms.form_1099_b_section(
            payer=brokerage, payer_tin=payer_tin, recipient=recipient, account=account,
            section_code=section["code"], rows=section["rows"], noncovered=section["noncovered"],
            filename=filename, page_number=page_number, doc=doc,
        )
        t_b["parentPage"] = 1
        truths.append(t_b)
        page_number += 1

    # ── supplemental, non-form pages ─────────────────────────────────────────
    sp = doc.new_page(width=LETTER.width, height=LETTER.height)
    sp.insert_text((MARGIN, MARGIN + 12), "Supplemental Information — Not Reported to the IRS",
                   fontname=FONT_BOLD, fontsize=12)
    y = 100.0
    for line in [
        "The amounts on this page are provided for your convenience and are not reported to",
        "the IRS. Your tax preparer may need them to complete your return.",
        "",
        "Accrued interest paid on purchases ................ 412.19",
        "Foreign tax paid — country: CANADA ................ 87.40",
        "Municipal bond premium amortization ............... 233.02",
        "Advisory fees (not deductible for 2025) ........... 1,940.00",
    ]:
        sp.insert_text((MARGIN, y), line, fontname=FONT, fontsize=9)
        y += 14
    sp.insert_text((MARGIN, LETTER.height - MARGIN),
                   "Synthetic fixture. Supplemental page.", fontname=FONT, fontsize=6.5, color=GREY)

    truths.append({
        "file": filename, "page": page_number, "formType": None, "taxYear": 2025,
        "isSupplemental": True, "fields": {},
    })

    if break_tie:
        truths[0]["expectedHardFailure"] = "consolidated_subforms_tie_to_summary:interest"

    return doc, truths


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"note": "All data is invented. Never replace these with client documents.",
                      "taxYear": 2025, "bundles": []}

    def save(doc: pymupdf.Document, name: str) -> None:
        doc.save(str(OUT / name), deflate=True, garbage=3)
        doc.close()

    # ── bundle 1: joint return, two TINs (one an ITIN), a planted prior-year 1098 ──
    docs: list[dict] = []

    w2_robert, t = forms.w2(
        employee=ROBERT, employer="ACME MANUFACTURING INC", employer_ein="43-1122334",
        box1=8_500_000, box2=1_142_000,
        box3=9_000_000, box4=558_000,      # 9,000,000 x 6.2% = 558,000 — reconciles
        box5=9_000_000, box6=130_500,      # 9,000,000 x 1.45% = 130,500 — reconciles
        box12=[("D", 500_000)],            # 401(k): explains box 1 < box 3 (soft failure)
        box16=9_000_000, box17=382_500,
        filename="w2_robert_native.pdf",
    )
    save(w2_robert, "w2_robert_native.pdf")
    t["expectedSoftFailure"] = "w2_box1_vs_box3_box5"
    docs.append(t)

    w2_maria, t = forms.w2(
        employee=MARIA, employer="OZARK REGIONAL HEALTH", employer_ein="43-5566778",
        box1=4_200_000, box2=402_000,
        box3=4_200_000, box4=260_400,
        box5=4_200_000, box6=60_900,
        box12=None, box16=4_200_000, box17=168_000,
        filename="w2_maria_native.pdf",
    )
    save(w2_maria, "w2_maria_native.pdf")
    docs.append(t)

    d_1098, t = forms.form_1098(
        lender="HERITAGE MORTGAGE CO", borrower=ROBERT,
        box1=1_284_400, box2=24_800_000, box6=None,
        filename="1098_current.pdf",
    )
    save(d_1098, "1098_current.pdf")
    docs.append(t)

    # The planted prior-year document (§7) — a real preparer error this catches.
    d_1098_old, t = forms.form_1098(
        lender="HERITAGE MORTGAGE CO", borrower=ROBERT,
        box1=1_341_900, box2=25_600_000, box6=None,
        tax_year=2024, filename="1098_prior_year.pdf",
    )
    save(d_1098_old, "1098_prior_year.pdf")
    t["expectedSoftFailure"] = "tax_year_matches_bundle"
    t["planted"] = "prior-year document in a 2025 bundle"
    docs.append(t)

    d_r, t = forms.form_1099_r(
        payer="VANGUARD FIDUCIARY TRUST", payer_tin="23-1945678", recipient=ROBERT,
        box1=2_500_000, box2a=None, box4=None,
        code="G", ira_sep_simple=False, taxable_not_determined=True,
        filename="1099r_code_g.pdf",
    )
    save(d_r, "1099r_code_g.pdf")
    t["expectedSoftFailure"] = "r_taxable_not_determined"
    t["note"] = "Code G rollover with taxable amount not determined — Judgment Required (§9)."
    docs.append(t)

    d_1095, t = forms.form_1095_a(
        recipient=MARIA, monthly_premium=94_200, monthly_slcsp=101_500, monthly_aptc=62_000,
        filename="1095a_full_year.pdf",
    )
    save(d_1095, "1095a_full_year.pdf")
    docs.append(t)

    manifest["bundles"].append({
        "name": "smith-joint-2025",
        "label": "Smith, Robert & Maria — 2025",
        "expectedTaxYear": 2025,
        "expectedTaxpayers": [
            {"name": ROBERT["name"], "tinLast4": ROBERT["last4"], "kind": "SSN"},
            {"name": MARIA["name"], "tinLast4": MARIA["last4"], "kind": "ITIN"},
        ],
        "documents": docs,
    })

    # ── bundle 2: three consolidated brokerage packages ──────────────────────
    brokerages = [
        dict(brokerage="NORTHSHORE SECURITIES LLC", payer_tin="13-2233445", account="NS-4471902",
             interest=124_500, ordinary_div=318_700, qualified_div=291_400, cap_gain=44_900,
             style="plain", filename="consolidated_brokerage_a.pdf", break_tie=False,
             b_rows=[
                 {"code": "A", "noncovered": False, "rows": [
                     ("100 SH ACME CORP", "03/02/2024", "07/11/2025", 1_842_000, 1_610_000),
                     ("50 SH BOREAL INC", "01/15/2025", "09/30/2025", 612_500, 588_000),
                 ]},
                 {"code": "B", "noncovered": True, "rows": [
                     ("300 SH LEGACY HOLDINGS", "unknown", "05/22/2025", 2_240_000, None),
                 ]},
             ]),
        dict(brokerage="MERIDIAN WEALTH PARTNERS", payer_tin="94-8877665", account="MWP-88213",
             interest=8_900, ordinary_div=1_204_300, qualified_div=1_102_800, cap_gain=318_600,
             style="indented", filename="consolidated_brokerage_b.pdf", break_tie=True,
             b_rows=[
                 {"code": "D", "noncovered": False, "rows": [
                     ("1,000 SH CEDAR ENERGY", "06/01/2019", "02/14/2025", 4_410_000, 2_980_000),
                 ]},
             ]),
        dict(brokerage="PIONEER TRUST BROKERAGE", payer_tin="36-1199223", account="PTB-2200-9",
             interest=61_200, ordinary_div=88_400, qualified_div=74_100, cap_gain=0,
             style="dense", filename="consolidated_brokerage_c.pdf", break_tie=False,
             b_rows=[
                 {"code": "A", "noncovered": False, "rows": [
                     ("25 SH DELTA LOGISTICS", "11/09/2024", "11/12/2025", 318_000, 305_500),
                 ]},
                 {"code": "E", "noncovered": True, "rows": [
                     ("VARIOUS — SEE STATEMENT", "various", "various", 1_115_000, None),
                 ]},
             ]),
    ]

    broker_docs: list[dict] = []
    for spec in brokerages:
        filename = spec.pop("filename")
        doc, truths = consolidated_1099(recipient=TRUST, filename=filename, **spec)
        save(doc, filename)
        broker_docs.extend(truths)

    manifest["bundles"].append({
        "name": "brokerage-packages-2025",
        "label": "Consolidated 1099 packages — three brokerages",
        "expectedTaxYear": 2025,
        "expectedTaxpayers": [{"name": TRUST["name"], "tinLast4": TRUST["last4"], "kind": "SSN"}],
        "documents": broker_docs,
    })

    # ── bundle 3: CORRECTED 1099-INT ─────────────────────────────────────────
    corrected_doc, t = forms.form_1099_int(
        payer="FIRST MONETT BANK", payer_tin="43-7788990", recipient=ROBERT,
        account="CHK-8890", box1=76_400, corrected=True, filename="1099int_corrected.pdf",
    )
    save(corrected_doc, "1099int_corrected.pdf")
    t["note"] = "CORRECTED box checked — must be flagged at classification, not extraction (P4)."
    manifest["bundles"].append({
        "name": "corrected-1099-2025",
        "label": "CORRECTED 1099-INT",
        "expectedTaxYear": 2025,
        "expectedTaxpayers": [{"name": ROBERT["name"], "tinLast4": ROBERT["last4"], "kind": "SSN"}],
        "documents": [t],
    })

    # ── bundle 4: K-1s from three renderings ─────────────────────────────────
    k1_docs: list[dict] = []
    for rendering, boxes, name in [
        ("UltraTax", {1: 4_120_000, 5: 18_400, 20: 0}, "k1_1065_ultratax.pdf"),
        ("CCH", {1: 890_000, 2: 210_000, 9: 55_000, 20: 0}, "k1_1065_cch.pdf"),
        ("Lacerte", {1: -240_000, 6: 12_900, 20: 0}, "k1_1065_lacerte.pdf"),
    ]:
        doc, t = forms.k1_1065(
            partnership="SPRINGFIELD COMMERCE PARTNERS LP", partner=ROBERT,
            boxes=boxes, rendering=rendering, filename=name,
        )
        save(doc, name)
        k1_docs.append(t)

    manifest["bundles"].append({
        "name": "k1-renderings-2025",
        "label": "K-1 (1065) from three tax packages, each with a §199A statement",
        "expectedTaxYear": 2025,
        "expectedTaxpayers": [{"name": ROBERT["name"], "tinLast4": ROBERT["last4"], "kind": "SSN"}],
        "documents": k1_docs,
    })

    # ── degraded variants of the W-2 ─────────────────────────────────────────
    source = pymupdf.open(str(OUT / "w2_robert_native.pdf"))

    scan = scanned(source)
    scan.save(str(OUT / "w2_robert_scanned.pdf"), deflate=True)
    scan.close()

    (OUT / "w2_robert_phone.jpg").write_bytes(phone_photo(source))
    source.close()

    manifest["degradedVariants"] = [
        {"file": "w2_robert_scanned.pdf", "derivedFrom": "w2_robert_native.pdf",
         "expectedRoute": "raster", "why": "image-only PDF, no text layer"},
        {"file": "w2_robert_phone.jpg", "derivedFrom": "w2_robert_native.pdf",
         "expectedRoute": "raster", "why": "loose image"},
        {"file": "w2_robert_native.pdf", "derivedFrom": None,
         "expectedRoute": "text_layer", "why": "native digital PDF with an embedded text layer"},
    ]

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    files = sorted(f.name for f in OUT.iterdir() if f.is_file())
    print(f"wrote {len(files)} fixture files to {OUT}/")
    for name in files:
        print(f"  {name}  ({(OUT / name).stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
