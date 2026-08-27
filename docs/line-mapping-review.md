# TY2025 line mapping — review request

**Status: reviewed 2026-08-26. Four decisions returned and applied — see §6.**
Covers `data/line-mappings/2025.json` (50 lines, 79 mappings) as of 2026-08-26.

I made judgment calls while building this. Most are routine; a handful are genuinely
debatable and a few are things I deliberately refused to decide. This document separates
those three groups so a review can spend its time where it matters.

**What a wrong mapping costs.** Nothing here computes tax. A mis-mapped box puts a correct
number under the wrong heading on a comparison worksheet — the preparer sees it in the wrong
place, not a wrong return. A *missing* mapping is caught: any populated money field with no
mapping is routed to Judgment Required as "no 2025 line mapping", so it surfaces rather than
disappearing. That safety net is why the debatable calls below are annoyances rather than
risks.

---

## 1. Routine — please skim, I do not expect disagreement

| Form | Box | → Line |
|---|---|---|
| W-2 | 1 Wages | 1040 1a (then 1z) |
| W-2 | 2 Federal withheld | 1040 25a |
| W-2 | 10 Dependent care | Form 2441 |
| W-2 | 17 State income tax | Schedule A 5a |
| 1099-INT | 1 Interest | 1040 2b (+ Schedule B detail) |
| 1099-INT | 3 US Savings Bonds / Treasury | 1040 2b |
| 1099-INT | 8 Tax-exempt interest | 1040 2a |
| 1099-DIV | 1a Ordinary dividends | 1040 3b (+ Schedule B detail) |
| 1099-DIV | 1b Qualified dividends | 1040 3a |
| 1099-DIV | 2a Capital gain distributions | Schedule D 13 |
| 1099-DIV | 12 Exempt-interest dividends | 1040 2a |
| 1099-OID | 11 Tax-exempt OID | 1040 2a |
| 1099-G | 1 Unemployment | Schedule 1 7 |
| 1098 | 1 Mortgage interest | Schedule A 8a |
| 1098 | 6 Points | Schedule A 8c |
| 1098-E | 1 Student loan interest | Schedule 1 21 |
| 1099-SA | 1 Gross distribution | Form 8889 |
| 1095-A | Annual A/B/C | Form 8962 |
| W-2G | 1 Reportable winnings | Schedule 1 8b |
| SSA-1099 | 5 Net benefits | 1040 6a |
| RRB-1099 | 4 Tier 1 SSEB | 1040 6a |
| All forms | Federal withheld on a 1099 | 1040 25b |

---

## 2. Calls I made that you may want to change

These are the ones I would flag in a review of someone else's work.

### 2.1 SSA-1099 box 6 withholding → line 25c, not 25b  — **RESOLVED: moved to 25b**

Voluntary withholding on an SSA-1099. Line 25b reads "Form(s) 1099" and an SSA-1099 is
literally a 1099, so 25b is defensible; I used **25c (other forms)** because the SSA form is
not one of the 1099 series the line contemplates. Same call for RRB-1099 box 10.

**Low stakes** — both roll into total withholding. Tell me which you prefer and it is a
one-line data change.

### 2.2 1099-MISC box 6 (medical and health care payments) → Schedule C

Correct when the recipient is the provider being paid, which is the common case. Wrong if
your client received it for something else. **Confirm this is the right default for your
client base.**

### 2.3 1099-NEC box 1 → Schedule C  — **RESOLVED: no change**

Right the large majority of the time, but nonemployee compensation also covers director
fees and genuinely non-business payments that belong on Schedule 1 8z. I took the common
case rather than routing every NEC to Judgment Required, which would be noisy.

**Ask:** would you rather every 1099-NEC land in Judgment Required so a human always
characterizes it?

### 2.4 1098 box 5 (mortgage insurance premiums) → Schedule A 8d  — **RESOLVED: deductible for TY2025, no change**

Mapped on the assumption the MIP deduction is available for TY2025. **This provision has
lapsed and been retroactively revived repeatedly — please confirm its TY2025 status.** If
it is not available, the right move is Judgment Required rather than an itemized line.

### 2.5 1099-MISC boxes 1 and 2 (rents, royalties) → Schedule 1 line 5  — **RESOLVED: no change**

Schedule 1 line 5 is the aggregate of Schedule E. The real destination is Schedule E, which
this worksheet does not model line by line. Reasonable for a comparison worksheet; flagging
in case you want a Schedule E section instead.

### 2.6 W-2 box 7 (social security tips) shown against Schedule 1-A, informational only

TY2025 adds the tips deduction on Schedule 1-A. This app does not compute it (§10) and line
1z reports gross wages exactly as printed. I show box 7 next to the Schedule 1-A tips line,
marked **informational** and excluded from every total, purely to point the preparer at a
deduction they need to compute themselves.

**Ask:** helpful signpost, or clutter? Easy to remove.

### 2.7 W-2 boxes 3–6 → a detail line, not Judgment Required  — **RESOLVED: auto-flag built**

Social security and Medicare wages and withholding have no Form 1040 line. They were
landing in Judgment Required, which meant every single W-2 buried the real judgment items
under four routine payroll figures. They now sit on a detail line whose label reads:

> Check for excess Social Security withholding across multiple employers, which is a
> Schedule 3 credit the preparer must claim.

**That prompt is the only thing standing between a two-employer client and a missed
credit.** If you want the app to do more here — say, flag automatically when combined box 4
across employers exceeds the annual maximum — that is a genuine feature request and I think
a good one. It is arithmetic on reported figures, not a characterization decision, so it
stays inside the §2 boundary.

---

## 3. Deliberately refused — routed to Judgment Required

Each of these reports the number as printed and stops. Confirm the *reasons* are right; if
any is actually mechanical, tell me and I will map it.

| Form | Box | Why it is not mapped |
|---|---|---|
| 1099-G | 2 State/local refunds | Taxability depends on whether the prior year itemized |
| 1099-S | 2 Gross proceeds | Gain depends on basis and the §121 exclusion |
| 1099-K | 1a Gross payments | Business versus personal-item character undetermined |
| 1099-R | 2a blank + "not determined" | Taxable portion is a preparer determination |
| 1098-T | 1, 5 | Payments received vs qualified expenses; scholarship netting |
| SSA-1099 | 3 Gross benefits | Taxable portion not computed — 6b shows "not computed" |
| 1099-B | 1e Missing basis, 1g Wash sales, noncovered lots | Not resolvable from the form |
| 1099-DIV | 3 Nondividend distributions | Reduces basis; basis unknown to this app |
| 1099-Q | 2 Earnings | Depends on qualified education expenses not reported here |
| 1099-LTC | 1 Gross benefits | Depends on qualified LTC costs |
| 5498 | 1 IRA contributions | Deductibility depends on AGI and plan coverage |
| W-2 | 8 Allocated tips | Form 4137 territory; includibility is a judgment |
| W-2 | 12a–d amounts | ~~All codes~~ **only codes not enumerated in §6** — W and the deferral codes now map |
| 1099-MISC | 10 Attorney proceeds | Not necessarily income to the recipient |
| 1099-INT 6 / 1099-DIV 7 | Foreign tax paid | De minimis election vs Form 1116 is a preparer choice |
| **All K-1s** | Every box | Boxes as printed only in v1 (§8) |

### The W-2 box 12 decision  — **RESOLVED: mechanical codes now mapped**

Every populated box 12 amount goes to Judgment Required regardless of code. That is
defensible — treatment genuinely depends on the code — but it means a code **D** (401(k)
deferral, informational) and a code **W** (HSA employer contribution, drives Form 8889) get
identical treatment, and a client with four box 12 entries produces four Judgment Required
rows every year.

A middle path: map the mechanical codes (**W** → Form 8889, **D/E/G/S** → informational)
and route only the ambiguous ones. **Do you want that?** It reduces noise but means the app
is reading a code and acting on it, which is closer to characterization than anything else
it does. I stayed conservative deliberately and would rather you make this call.

---

## 4. Gaps I found while writing this — now fixed

Two mappings were simply missing. Both would have surfaced as unmapped in Judgment Required
rather than vanishing, but they belonged on real lines:

- **1099-INT box 2 / 1099-OID box 3 — early withdrawal penalty** → Schedule 1 line 18. This
  is an above-the-line deduction and is entirely mechanical. **Added.**
- **1099-INT box 6 / 1099-DIV box 7 — foreign tax paid** → routed to Judgment Required with
  an explicit reason, rather than guessed. **Added.**

---

## 5. Known structural limits

- **No state section.** W-2 box 17 and 1099 state withholding are captured and shown as
  detail but do not roll up to Missouri line references (QUESTIONS.md Q9). Confirm this is
  right for v1.
- **No prior-year column.** Present in the layout, deliberately empty — there is no client
  master and no prior season of data (§7).
- **Schedule E and Schedule C are aggregates**, not modelled line by line.
- **Schedule 1-A lines exist but compute nothing.** Tips, overtime, car-loan interest, and
  the enhanced senior deduction each render as "not computed" with the reason attached.

---

## How to give me changes

Anything in §2 and §3 is a data change to `data/line-mappings/2025.json` — no code, no
release. Mark this document up however is convenient, or just tell me the box and the line.

The two questions I would most like answered:

1. **W-2 box 12** — map the mechanical codes, or keep everything in Judgment Required?
2. **Excess Social Security withholding across employers** — should the app flag it
   automatically?


---

## 6. Review outcome — 2026-08-26

| Question | Decision | Applied |
|---|---|---|
| W-2 box 12 handling | **Map the mechanical codes** | Code W → Form 8889 line 9. Codes D/E/F/G/H/S/AA/BB/EE → an informational detail line (already inside box 1, no separate line). Any code not enumerated still falls through to Judgment Required. |
| Excess Social Security across employers | **Flag automatically** | New bundle-level soft check, per taxpayer. Fires only with two or more employers, since a single employer over-withholding is a W-2 error that `w2_ss_tax_rate` already catches. |
| SSA-1099 / RRB-1099 withholding | **Move to line 25b** | Was 25c. |
| 1098 box 5 MIP | **No change** — deductible for TY2025 | Stays on Schedule A 8d. |
| 1099-NEC → Schedule C | **No change** | Stays mapped; not routed to Judgment. |
| 1099-MISC rents/royalties | **No change** | Stays on Schedule 1 line 5; no Schedule E section in v1. |

### A bug the box 12 change exposed

Supporting conditional routing by code meant a field could have mappings where *none* of the
conditions matched. The engine treated that as "already mapped, nothing to do" and **dropped
the value silently** — a populated box vanishing off the worksheet, which is the precise
failure this tool exists to prevent. It only ever had two exhaustive true/false conditions
before (the 1099-R IRA split), so nothing had exercised it.

Unmatched conditionals now route to Judgment Required with a reason naming the situation.
That is also what makes the conservative half of the box 12 decision safe: an unrecognised
code cannot disappear, it lands in front of a human.

### Per-taxpayer, not per-bundle

The excess-withholding check groups W-2s by taxpayer before comparing. Summing across a
married couple would invent a credit that does not exist, since each spouse has their own
wage base. Tested explicitly.
