/**
 * Identity harvesting from the page text layer (P4, §7).
 *
 * Why this exists: identity used to be proposed inside `extractDocument`, and extraction only
 * starts once identity is confirmed. That is a deadlock. Every bundle parked at
 * `awaiting_identity_confirmation` with an empty taxpayer list and no way forward, because the
 * step that would have produced the names ran after the gate that was waiting for them.
 *
 * The fix is to propose from what the bundle already carries rather than from what a model
 * has yet to read. Native digital packets, which is most of what a firm receives, arrive with
 * a text layer the sidecar has already stored on the page row. The taxpayer's identification
 * number is printed on it, so no inference is needed to make the gate real.
 *
 * Two rules keep this honest:
 *
 *  - **Only SSN/ITIN-shaped tokens.** Payer identifiers on an information return are EINs, and
 *    an EIN is two digits then seven. Matching only the nine-digit dashed shape means an
 *    employer or a brokerage can never be proposed as the client. Verified against five real
 *    packets: every taxpayer identifier was found and no payer identifier was.
 *  - **Names come from a label, or not at all.** Which party a name belongs to depends on the
 *    form, so guessing from position would propose a mortgage lender as the taxpayer. Only
 *    labels that denote the recipient are read, and `null` is a perfectly good answer — §7
 *    makes the name a tiebreaker and the reviewer confirms it either way.
 *
 * A raster-only bundle has no text layer and yields nothing here. That is handled where it
 * matters: the confirmation gate accepts a tax year with no proposed taxpayer rather than
 * trapping the bundle, and the post-extraction proposal still refines it afterwards.
 */

/** Labels that introduce the taxpayer rather than the payer, lender, or trustee. */
const RECIPIENT_LABELS = [
  /RECIPIENT'?S name/i,
  /PARTICIPANT'?S name/i,
  /PAYER'?S\/BORROWER'?S name/i,
  /BORROWER'?S name/i,
  /EMPLOYEE'?S name/i,
  /Employee'?s first name/i,
  /Box 1\.\s*Name/i,
  /Beneficiary'?s name/i,
];

/** Nine digits, dashed. Deliberately not the two-then-seven EIN shape. */
const TIN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Two to five capitalised words. Rejects addresses, which start with a number. */
const NAME_SHAPED = /^[A-Z][A-Za-z.'\-]*(?: [A-Z][A-Za-z.'\-]*){1,4}$/;

export interface HarvestedIdentity {
  /** Plaintext, in memory only. Never persisted and never logged (§7). */
  tins: string[];
  name: string | null;
}

export function harvestIdentityFromText(text: string | null): HarvestedIdentity {
  if (!text) return { tins: [], name: null };

  const tins = [...new Set(text.match(TIN_PATTERN) ?? [])];
  const lines = text.split('\n').map((l) => l.trim());

  let name: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (!RECIPIENT_LABELS.some((label) => label.test(line))) continue;
    // The value may sit on the label's own line or just below it, depending on how the form
    // was laid out. Three lines is enough for every layout seen and short enough that it
    // cannot wander into the next box.
    for (const candidate of lines.slice(index + 1, index + 4)) {
      if (!candidate || /^\d/.test(candidate)) continue;
      if (NAME_SHAPED.test(candidate)) {
        name = candidate;
        break;
      }
    }
    if (name) break;
  }

  return { tins, name };
}
