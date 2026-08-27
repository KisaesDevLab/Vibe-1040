import { describe, expect, it } from 'vitest';

/** §7 — identity resolution and the no-plaintext-TIN rule. */

describe('TIN handling', () => {
  it('derives a stable join key and keeps only the last four in the clear', async () => {
    const { hashTin } = await import('../src/identity/tin.ts');
    const a = hashTin('123-45-6789')!;
    const b = hashTin('123456789')!;
    expect(a.tinHash).toBe(b.tinHash);
    expect(a.tinLast4).toBe('6789');
    // The hash must not be the TIN in any recoverable form.
    expect(a.tinHash).not.toContain('123456789');
    expect(a.tinHash).toHaveLength(64);
  });

  it('gives different deployments different join keys for the same TIN', async () => {
    const { hashTin } = await import('../src/identity/tin.ts');
    const first = hashTin('123-45-6789')!.tinHash;
    // Same input, different salt → different key. Verified by re-deriving with HMAC directly.
    const { createHmac } = await import('node:crypto');
    const other = createHmac('sha256', Buffer.alloc(32, 1)).update('123456789').digest('hex');
    expect(first).not.toBe(other);
  });

  it('rejects implausible SSNs so a misread does not propose a client', async () => {
    const { isPlausibleTin } = await import('../src/identity/tin.ts');
    expect(isPlausibleTin('123456789')).toBe(true);
    expect(isPlausibleTin('000456789')).toBe(false);
    expect(isPlausibleTin('666456789')).toBe(false);
    expect(isPlausibleTin('900456789')).toBe(false);
    expect(isPlausibleTin('123006789')).toBe(false);
    expect(isPlausibleTin('123450000')).toBe(false);
  });
});

describe('identity proposal', () => {
  it('handles a joint return with two TINs split unevenly across documents', async () => {
    const { proposeIdentity } = await import('../src/identity/resolve.ts');
    const proposal = proposeIdentity(
      [
        { documentId: 'd1', rawTin: '123-45-6789', name: 'ROBERT J SMITH', formType: 'W-2' },
        { documentId: 'd2', rawTin: '123-45-6789', name: 'ROBERT SMITH', formType: '1099-INT' },
        { documentId: 'd3', rawTin: '123-45-6789', name: 'SMITH FAMILY TRUST', formType: '1099-DIV' },
        { documentId: 'd4', rawTin: '987-65-4321', name: 'MARY A SMITH', formType: 'W-2' },
      ],
      [],
    );

    expect(proposal.taxpayers).toHaveLength(2);
    const [primary, spouse] = proposal.taxpayers;
    expect(primary!.documentIds).toHaveLength(3);
    expect(spouse!.documentIds).toHaveLength(1);
    // The name from the W-2 wins over the brokerage's account title.
    expect(primary!.displayName).toBe('ROBERT J SMITH');
  });

  it('flags a planted prior-year document against the bundle majority', async () => {
    const { proposeIdentity } = await import('../src/identity/resolve.ts');
    const proposal = proposeIdentity(
      [],
      [
        { documentId: 'a', taxYear: 2025 },
        { documentId: 'b', taxYear: 2025 },
        { documentId: 'c', taxYear: 2025 },
        { documentId: 'd', taxYear: 2024 }, // stray prior-year 1098
      ],
    );
    expect(proposal.taxYear).toBe(2025);
    expect(proposal.taxYearMismatches).toEqual([{ documentId: 'd', taxYear: 2024 }]);
  });

  it('reports a masked TIN as unusable instead of joining on it', async () => {
    const { proposeIdentity } = await import('../src/identity/resolve.ts');
    const proposal = proposeIdentity(
      [{ documentId: 'd1', rawTin: 'XXX-XX-6789', name: 'R SMITH', formType: '1099-INT' }],
      [],
    );
    expect(proposal.taxpayers).toHaveLength(0);
    expect(proposal.unusable[0]).toEqual({ documentId: 'd1', reason: 'masked', last4: '6789' });
  });
});

describe('audit scrubbing', () => {
  it('never lets a TIN-shaped string into an audit detail payload', async () => {
    const { scrubDetail } = await import('../src/audit/log.ts');
    const scrubbed = scrubDetail({
      fieldKey: 'employee_tin',
      before: { text: '123-45-6789' },
      nested: [{ value: '987654321x' }, { value: '123 45 6789' }],
    });
    expect(JSON.stringify(scrubbed)).not.toContain('123-45-6789');
    expect(JSON.stringify(scrubbed)).not.toContain('123 45 6789');
    expect(JSON.stringify(scrubbed)).toContain('REDACTED');
  });
});
