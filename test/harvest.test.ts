import { describe, expect, it } from 'vitest';
import { harvestIdentityFromText } from '../src/identity/harvest.ts';

/**
 * These strings are lifted from the text layer of real synthetic client packets, because the
 * failure this guards against was not a parsing subtlety — it was proposing the wrong party.
 */
describe('harvestIdentityFromText', () => {
  it('takes the employee, not the employer, off a W-2', () => {
    const { tins, name } = harvestIdentityFromText(
      [
        "a Employee's social security number",
        '555-38-9217',
        'b Employer identification number (EIN)',
        '85-4729163',
        "e Employee's first name and initial    Last name    Suff.",
        'Elara Tunde Smith',
      ].join('\n'),
    );
    expect(tins).toEqual(['555-38-9217']);
    expect(name).toBe('Elara Tunde Smith');
  });

  it('reads spaced and label-adjacent bare nine-digit numbers, never an EIN-shaped one', () => {
    expect(harvestIdentityFromText('Social security number 555 38 9217').tins).toEqual(['555 38 9217']);
    expect(harvestIdentityFromText("RECIPIENT'S TIN\n555389217\nAccount 123456789").tins).toEqual(['555389217']);
    expect(harvestIdentityFromText('Account number 555389217').tins).toEqual([]);
  });

  it('keeps a masked number as a last-four hint with the recipient name', () => {
    const h = harvestIdentityFromText("RECIPIENT'S TIN\nXXX-XX-8214\nRECIPIENT'S name\nMARCUS D WILLIAMS");
    expect(h.tins).toEqual([]);
    expect(h.maskedLast4).toEqual(['8214']);
    expect(h.name).toBe('MARCUS D WILLIAMS');
    expect(harvestIdentityFromText('Taxpayer ID ***-**-1234').maskedLast4).toEqual(['1234']);
    expect(harvestIdentityFromText('SSN ending in 4321').maskedLast4).toEqual(['4321']);
  });

  it('ignores an EIN entirely, so a payer can never be proposed as the client', () => {
    const { tins } = harvestIdentityFromText('PAYER’S TIN\n85-1092437\nRECIPIENT’S TIN\n555-38-9217');
    expect(tins).toEqual(['555-38-9217']);
  });

  it('reads the borrower off a 1098 rather than the lender', () => {
    const { name } = harvestIdentityFromText(
      [
        "RECIPIENT'S/LENDER'S name, street address",
        'High Desert Mortgage Company',
        "PAYER'S/BORROWER'S name",
        'Elara Tunde Smith',
      ].join('\n'),
    );
    expect(name).toBe('Elara Tunde Smith');
  });

  it('reads the box-1 name on an SSA-1042S', () => {
    const { tins, name } = harvestIdentityFromText(
      'Box 1. Name\nDOLORES M HENNING\nBox 2. Beneficiary’s Social Security Number\n555-71-8294',
    );
    expect(name).toBe('DOLORES M HENNING');
    expect(tins).toEqual(['555-71-8294']);
  });

  it('skips an address line when looking for the name', () => {
    const { name } = harvestIdentityFromText("RECIPIENT'S name\n4821 W Overland Road\nDolores Henning");
    expect(name).toBe('Dolores Henning');
  });

  it('returns nothing rather than guessing when there is no text layer', () => {
    expect(harvestIdentityFromText(null)).toEqual({ tins: [], maskedLast4: [], name: null });
    expect(harvestIdentityFromText('   ')).toEqual({ tins: [], maskedLast4: [], name: null });
  });

  it('reports a name-less page honestly instead of inventing one', () => {
    const { tins, name } = harvestIdentityFromText('Some page with 555-38-9217 and no label at all');
    expect(tins).toEqual(['555-38-9217']);
    expect(name).toBeNull();
  });
});
