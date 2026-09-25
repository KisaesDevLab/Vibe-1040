/**
 * Check the node map against the engine's own input-node catalogue (P17).
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────
 *
 * `src/draft/nodes.ts` checks that the node map is internally consistent: every registered form
 * type declared, every field accounted for exactly once, no engine field targeted twice. What
 * it cannot check is whether the names it holds are names the engine actually has — it has no
 * view of the engine at all.
 *
 * That gap has a sharp edge, verified against engine 2.0.4 rather than reasoned about. A field
 * renamed between engine releases fails in one of two ways:
 *
 *  - **Required field renamed** — `form add` refuses the whole node, the wrapper reports it in
 *    `rejected`, and the app carries it into the omissions. Loud, and already handled.
 *  - **Optional field renamed** — the engine accepts the payload and *ignores* the unknown key.
 *    The amount never reaches the return. The line comes back **absent**, and absent is exactly
 *    what "the documents reported nothing on this line" looks like (§14). Nothing is rejected,
 *    nothing is logged, and the omissions list does not mention it either, because from the
 *    translator's side the field was sent successfully.
 *
 * A 1099-INT box 1 of 12,345 sent as `box1_interest` rather than `box1` leaves
 * `line2b_taxable_interest` missing and every total confidently wrong. That is the silent
 * omission this whole app exists to prevent, arriving through the one door the omissions
 * contract does not cover — so it is closed here instead, by comparing names before sending.
 *
 * ── What this is not ───────────────────────────────────────────────────────────────────────
 *
 * It is a name check, not a behaviour check. It cannot see that a field kept its name and
 * changed its meaning, or that the engine's arithmetic moved. `npm run draft -- --truth` is
 * what measures behaviour, and an upgrade needs both.
 */
import { fetchCatalog, type EngineCatalog } from './client.ts';
import { type NodeMapFile } from './nodes.ts';

export type CatalogFindingKind =
  /** The node map targets a node type the engine does not have. Nothing of that form computes. */
  | 'node_type_absent'
  /** We would send a field name the engine does not have. Silently dropped if optional. */
  | 'field_unknown'
  /** The engine requires a field the map neither sends nor has a withholding rule for. */
  | 'required_field_unmapped'
  /** We treat a field as engine-required and the engine says it is optional, or the reverse. */
  | 'required_flag_stale';

export interface CatalogFinding {
  /**
   * `blocking` stops a draft being produced. A wrong draft is worse than no draft, and the
   * worksheet is unaffected either way — only the optional checking aid is withheld.
   */
  severity: 'blocking' | 'advisory';
  kind: CatalogFindingKind;
  formType: string;
  nodeType: string;
  /** The engine-side field name, where the finding is about one. */
  engineField?: string;
  detail: string;
}

export interface CatalogCheck {
  engineVersion: string;
  /** Node types asked about, so a caller can say what was and was not covered. */
  nodeTypes: string[];
  findings: CatalogFinding[];
  blocking: CatalogFinding[];
  ok: boolean;
}

/**
 * The node types the map targets, plus `general`.
 *
 * `general` carries the filing status and the age and blindness flags, which come from the
 * reviewer rather than from a document (§14 rule 5), so it is not on any form's map and would
 * otherwise go unchecked — and a rename there loses the standard deduction and the whole tax
 * computation, which is how the long filing-status names were caught.
 */
export function mappedNodeTypes(file: NodeMapFile): string[] {
  return [...new Set([...file.forms.map((f) => f.nodeType), 'general'])].sort();
}

/**
 * Every engine field name the map intends to send for a form, mapped to what this app calls
 * it — so a finding can name the box a preparer would recognise, not just the engine's key.
 *
 * All four mapping kinds contribute: plain fields, the constants a binding implies, a code
 * group's single collapsed array (W-2 box 12), and a monthly array (1095-A).
 */
function intendedFields(form: NodeMapFile['forms'][number]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of form.fields) out.set(f.nodeField, f.fieldKey);
  for (const g of form.codeGroups) out.set(g.nodeField, `${g.pairs.length} code/amount pair(s)`);
  for (const m of form.monthlyArrays) out.set(m.nodeField, `12 monthly boxes`);
  for (const key of Object.keys(form.constants)) out.set(key, 'a constant this binding implies');
  return out;
}

/**
 * Compare a node map against a catalogue the engine reported.
 *
 * Pure, so the whole matrix of agreements and disagreements is testable with no engine.
 */
export function checkAgainstCatalog(file: NodeMapFile, catalog: EngineCatalog): CatalogCheck {
  const findings: CatalogFinding[] = [];

  for (const form of file.forms) {
    const node = catalog.nodes[form.nodeType];
    if (!node || node.implemented === false) {
      findings.push({
        severity: 'blocking',
        kind: 'node_type_absent',
        formType: form.formType,
        nodeType: form.nodeType,
        detail:
          `The engine has no input node \`${form.nodeType}\`` +
          `${node?.reason ? ` (${node.reason})` : ''}. Every ${form.formType} would be refused. ` +
          'Either the node was renamed or removed in this release, or the map targets a node ' +
          'that never existed.',
      });
      continue;
    }

    const known = new Set([...Object.keys(node.fields ?? {}), ...(node.otherFields ?? [])]);
    const intended = intendedFields(form);

    for (const [engineField, fieldKey] of intended) {
      if (!known.has(engineField)) {
        findings.push({
          severity: 'blocking',
          kind: 'field_unknown',
          formType: form.formType,
          nodeType: form.nodeType,
          engineField,
          detail:
            `\`${form.nodeType}.${engineField}\` (this app's \`${fieldKey}\`) is not a field on ` +
            'the engine node. If it is optional there, the engine accepts the payload and ' +
            'ignores it, so the amount vanishes and the line reads as absent — with no error ' +
            'anywhere. Find what it was renamed to and update the node map.',
        });
        continue;
      }

      const spec = node.fields?.[engineField];
      const declared = form.fields.find((f) => f.nodeField === engineField);
      if (spec && declared && spec.required !== (declared.engineRequired ?? false)) {
        findings.push({
          severity: 'advisory',
          kind: 'required_flag_stale',
          formType: form.formType,
          nodeType: form.nodeType,
          engineField,
          detail: spec.required
            ? `The engine requires \`${engineField}\` and the map does not mark it ` +
              '`engineRequired`. A document missing it is sent and refused whole, rather than ' +
              'withheld with a reason a reviewer can read.'
            : `The map marks \`${engineField}\` \`engineRequired\` and the engine says it is ` +
              'optional. Documents are being withheld that the engine would have accepted, so ' +
              'drafts are less complete than they need to be.',
        });
      }
    }

    // A field the engine requires that the map has no plan for at all. Not blocking on its
    // own — the map may legitimately refuse to supply it, as §7 refuses to forward a TIN —
    // but every document of that type will be refused, so it must not be silent.
    for (const [engineField, spec] of Object.entries(node.fields ?? {})) {
      if (!spec.required || intended.has(engineField)) continue;
      findings.push({
        severity: 'advisory',
        kind: 'required_field_unmapped',
        formType: form.formType,
        nodeType: form.nodeType,
        engineField,
        detail:
          `The engine requires \`${form.nodeType}.${engineField}\` and the map sends nothing ` +
          `for it, so every ${form.formType} is refused. If this app cannot supply it — a TIN ` +
          'never leaves here (§7) — the form type belongs in `unmappable` with a reason, not ' +
          'in `forms`.',
      });
    }
  }

  // `general` is not a form, so it is checked on its own terms: the filing statuses the map
  // offers the reviewer have to be values the engine's `general` node will accept.
  const general = catalog.nodes['general'];
  if (general && general.implemented !== false && (general.fields?.['filing_status'] === undefined)) {
    findings.push({
      severity: 'blocking',
      kind: 'field_unknown',
      formType: '(filing status)',
      nodeType: 'general',
      engineField: 'filing_status',
      detail:
        "The engine's `general` node has no `filing_status` field. Nothing computes without " +
        'it: the standard deduction and the entire tax calculation depend on it.',
    });
  }

  const blocking = findings.filter((f) => f.severity === 'blocking');
  return {
    engineVersion: catalog.engineVersion,
    nodeTypes: mappedNodeTypes(file),
    findings,
    blocking,
    ok: blocking.length === 0,
  };
}

/**
 * Memoized by engine version *and* node-map version, because either moving invalidates it.
 *
 * Checking on every draft would mean a process spawn per node type per draft. Checking once is
 * enough: neither the binary nor the map can change under a running process.
 */
const cache = new Map<string, CatalogCheck>();

export async function engineCatalogCheck(file: NodeMapFile): Promise<CatalogCheck> {
  const catalog = await fetchCatalog(mappedNodeTypes(file));
  const key = `${catalog.engineVersion}::${file.version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const check = checkAgainstCatalog(file, catalog);
  cache.set(key, check);
  return check;
}

export function __clearCatalogCheckCache(): void {
  cache.clear();
}

/** One line per finding, for a startup log or a CLI. */
export function formatFindings(check: CatalogCheck): string[] {
  return check.findings.map(
    (f) => `[${f.severity}] ${f.formType} → ${f.nodeType}${f.engineField ? `.${f.engineField}` : ''}: ${f.detail}`,
  );
}
