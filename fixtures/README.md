# Fixtures

Synthetic tax documents plus ground truth, generated deterministically.

```bash
pip install PyMuPDF Pillow
python fixtures/generate.py test/fixtures
```

**Everything here is invented.** Never replace a fixture with a client document, even a
de-identified one — CLAUDE.md's fixture rule exists because de-identification is easy to
get subtly wrong and impossible to undo once committed.

## What is where

| module | role |
|---|---|
| `draw.py` | primitives: boxes, labelled grids, party blocks, money formatting |
| `forms.py` | one function per form type, each returning `(document, ground_truth)` |
| `degrade.py` | derives the scanned and phone-photo variants from a native PDF |
| `generate.py` | assembles the bundles and writes `manifest.json` |

## The manifest is the point

`test/fixtures/manifest.json` records the expected value of every field. Critically it
distinguishes **blank** (`null`) from **printed zero** (`0`), which is the distinction the
whole product turns on (§5). A fixture without ground truth only proves the pipeline runs;
with it, extraction accuracy becomes assertable.

It also records what each fixture is *for*: `expectedHardFailure`, `expectedSoftFailure`,
`expectedRoute`, `planted`. Those are what the phase exit criteria check against.

## Deliberate defects

Some fixtures are wrong on purpose, because the gate has to catch them:

- `consolidated_brokerage_b.pdf` — the package summary reports $25.00 more interest than
  its own 1099-INT sub-form. Hard failure.
- `1098_prior_year.pdf` — a TY2024 document in a TY2025 bundle. Soft failure.
- `1099r_code_g.pdf` — code G rollover, box 2a blank, "taxable amount not determined"
  checked. Judgment Required.
- Noncovered 1099-B lots print no cost basis at all. Judgment Required.

## Adding a form

Add a function to `forms.py` returning `(pymupdf.Document, ground_truth)`, call it from
`generate.py`, and re-run. `test/fixtures.test.ts` will fail if a field key you invent is
not registered in `data/form-schemas/`, which is the check that keeps fixtures and schemas
from drifting apart.
