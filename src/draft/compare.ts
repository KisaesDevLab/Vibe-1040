/**
 * Putting the engine's computed lines beside the worksheet's reported totals (P17).
 *
 * This is where the phase earns its place. The worksheet says "the documents report $X on line
 * 1z"; the engine says "line 1z computes to $Y". When they differ, one of them is wrong, and a
 * disagreement on a 1040 line is far easier to see than a defect buried in a field map. That is
 * also why this doubles as the accuracy harness the pipeline has never had.
 *
 * **This is not §2's diff engine.** Both sides are derived by this app from the same source
 * documents. Nothing is read out of a prepared return.
 *
 * Every figure here is advisory. A disagreement is a prompt to look, not a verdict, and several
 * are expected by construction — the node map's `note` field says which and why, because an
 * expected disagreement presented as a defect trains a reviewer to ignore the whole panel.
 */
import { formatCents } from '../lib/money.ts';
import type { WorksheetModel } from '../mapping/engine.ts';
import type { EngineResult } from './client.ts';
import type { NodeMapFile } from './nodes.ts';

export type ComparisonVerdict =
  /** Both sides present and inside tolerance. */
  | 'agrees'
  /** Both sides present and outside tolerance. Look at this one. */
  | 'differs'
  /** The worksheet reports a figure the engine has nothing for. */
  | 'engine_silent'
  /** The engine computed a figure the worksheet does not report. */
  | 'worksheet_silent'
  /** Neither side has anything. Not shown by default. */
  | 'both_blank';

export interface ComparedLine {
  lineRef: string;
  label: string;
  sortOrder: number;
  engineForm: string;
  engineLine: string;
  reportedCents: number | null;
  computedCents: number | null;
  deltaCents: number | null;
  verdict: ComparisonVerdict;
  /** Why a disagreement here may be expected rather than a defect. */
  note?: string;
}

export interface ComputedOnlyFigure {
  engineForm: string;
  engineLine: string;
  label: string;
  computedCents: number | null;
}

export interface DraftComparison {
  toleranceCents: number;
  lines: ComparedLine[];
  computedOnly: ComputedOnlyFigure[];
  counts: Record<ComparisonVerdict, number>;
  /** Lines worth a reviewer's attention: a real disagreement, note or no note. */
  differing: ComparedLine[];
}

/**
 * The engine reports dollars; everything in this app is integer cents.
 *
 * Rounding rather than truncating, and `null` for anything that is not a finite number — an
 * absent line is absent, and must not become a zero on the way in any more than on the way out
 * (§5). The engine does emit real zeros for lines it computed to zero, and those are kept.
 */
function toCents(value: unknown): number | null {
  const n = Array.isArray(value) ? value[0] : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function engineCents(result: EngineResult, form: string, line: string): number | null {
  return toCents(result.lines[form]?.[line]);
}

export function compareDraft(
  file: NodeMapFile,
  worksheet: WorksheetModel,
  result: EngineResult,
  toleranceCents: number,
): DraftComparison {
  const reported = new Map(worksheet.lines.map((l) => [l.lineRef, l]));

  const lines: ComparedLine[] = [];
  for (const map of file.lines.comparable) {
    const line = reported.get(map.lineRef);
    const reportedCents = line?.totalCents ?? null;
    const computedCents = engineCents(result, map.engineForm, map.engineLine);

    let verdict: ComparisonVerdict;
    let deltaCents: number | null = null;
    if (reportedCents === null && computedCents === null) verdict = 'both_blank';
    else if (computedCents === null) verdict = 'engine_silent';
    else if (reportedCents === null) verdict = 'worksheet_silent';
    else {
      deltaCents = computedCents - reportedCents;
      verdict = Math.abs(deltaCents) <= toleranceCents ? 'agrees' : 'differs';
    }

    lines.push({
      lineRef: map.lineRef,
      label: line?.label ?? map.lineRef,
      sortOrder: line?.sortOrder ?? Number.MAX_SAFE_INTEGER,
      engineForm: map.engineForm,
      engineLine: map.engineLine,
      reportedCents,
      computedCents,
      deltaCents,
      verdict,
      ...(map.note === undefined ? {} : { note: map.note }),
    });
  }
  lines.sort((a, b) => a.sortOrder - b.sortOrder);

  const counts: Record<ComparisonVerdict, number> = {
    agrees: 0,
    differs: 0,
    engine_silent: 0,
    worksheet_silent: 0,
    both_blank: 0,
  };
  for (const line of lines) counts[line.verdict] += 1;

  return {
    toleranceCents,
    lines,
    computedOnly: file.lines.computedOnly.map((c) => ({
      engineForm: c.engineForm,
      engineLine: c.engineLine,
      label: c.label,
      computedCents: engineCents(result, c.engineForm, c.engineLine),
    })),
    counts,
    // `engine_silent` is usually a withheld document rather than a defect, and is listed
    // separately in the omissions rather than dressed up as a disagreement here.
    differing: lines.filter((l) => l.verdict === 'differs'),
  };
}

/** One line of prose per disagreement, for the harness report and the workbook. */
export function describeDifference(line: ComparedLine): string {
  const reported = line.reportedCents === null ? 'nothing' : formatCents(line.reportedCents);
  const computed = line.computedCents === null ? 'nothing' : formatCents(line.computedCents);
  const head = `${line.lineRef}: worksheet reports ${reported}, engine computes ${computed}`;
  return line.note ? `${head}. Expected: ${line.note}` : `${head}.`;
}
