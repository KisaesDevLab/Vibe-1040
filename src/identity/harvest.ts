/**
 * Identity harvesting from the page text layer (P4, §7).
 *
 * Proposes the taxpayer from what the bundle already carries rather than from what a model
 * has yet to read. Native digital packets arrive with a text layer the sidecar has stored on
 * the page row; the taxpayer's identification number is printed on it, so no inference is
 * needed to make the confirm panel real.
 *
 * Rules that keep this honest:
 *
 *  - **Only SSN/ITIN-shaped tokens.** Payer identifiers on an information return are EINs
 *    (two digits, seven digits) and are never matched. A nine-digit run with no separators is
 *    accepted only when it sits right after a label that names a social security or taxpayer
 *    identification number, because account numbers are nine digits too.
 *  - **Masked numbers are hints, not keys.** "XXX-XX-8214" cannot be hashed, but its last
 *    four plus the name beside it tell the reviewer whose full number to type. Brokerage
 *    statements mask by default, so without this the confirm panel says "nobody to propose"
 *    on most consolidated packages.
 *  - **Names come from a label, or not at all.** Only labels that denote the recipient are
 *    read; `null` is a fine answer, since §7 makes the name a tiebreaker and the reviewer
 *    confirms it either way.
 */

/** Labels that introduce the taxpayer rather than the payer, lender, or trustee. */
const RECIPIENT_LABELS = [
  /RECIPIENT'?S name/i,
  /PARTICIPANT'?S name/i,
  /PAYER'?S\/BORROWER'?S name/i,
  /BORROWER'?S name/i,
  /STUDENT'?S name/i,
  /BENEFICIARY'?S name/i,
  /PARTNER'?S name/i,
  /SHAREHOLDER'?S name/i,
  /WINNER'?S name/i,
  /EMPLOYEE'?S name/i,
  /Employee'?s first name/i,
  /Box 1\.\s*Name/i,
  /Account (?:holder|owner)/i,
];

/** Dashed or spaced nine digits: never the two-then-seven EIN shape. */
const TIN_PATTERN = /\b\d{3}[-‑ ]\d{2}[-‑ ]\d{4}\b/g;

/** Nine bare digits right after a label that names a social security / taxpayer number. */
const LABELLED_BARE_TIN =
  /(?:social security (?:number|no\.?)|SSN|taxpayer identification (?:number|no\.?)|RECIPIENT'?S (?:TIN|identification)|TIN)[^\d]{0,40}(\d{9})\b/gi;

/** A masked TIN: XXX-XX-8214, ***-**-8214, •••-••-8214, or "ending in 8214". */
const MASKED_PATTERN = /(?:[X*•●]{3}[-‑ ]?[X*•●]{2}[-‑ ]?(\d{4})\b|\b(?:ending in|last four|last 4)\D{0,6}(\d{4})\b)/gi;

/** Two to five capitalised words. Rejects addresses, which start with a number. */
const NAME_SHAPED = /^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){1,4}$/;

export interface HarvestedIdentity {
  /** Plaintext, in memory only. Never persisted and never logged (§7). */
  tins: string[];
  /** Last four digits of masked numbers — hints for the reviewer, never keys. */
  maskedLast4: string[];
  name: string | null;
}

export function harvestIdentityFromText(text: string | null): HarvestedIdentity {
  if (!text) return { tins: [], maskedLast4: [], name: null };

  const tins = new Set<string>(text.match(TIN_PATTERN) ?? []);
  for (const m of text.matchAll(LABELLED_BARE_TIN)) tins.add(m[1]!);

  const maskedLast4 = new Set<string>();
  for (const m of text.matchAll(MASKED_PATTERN)) maskedLast4.add((m[1] ?? m[2])!);

  const lines = text.split('\n').map((l) => l.trim());

  let name: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (!RECIPIENT_LABELS.some((label) => label.test(line))) continue;
    // The value may sit on the label's own line (after a colon) or just below it.
    const after = line.split(/:\s*/)[1];
    const candidates = [after ?? '', ...lines.slice(index + 1, index + 4)];
    for (const candidate of candidates) {
      if (!candidate || /^\d/.test(candidate)) continue;
      if (NAME_SHAPED.test(candidate)) {
        name = candidate;
        break;
      }
    }
    if (name) break;
  }

  return { tins: [...tins], maskedLast4: [...maskedLast4], name };
}
