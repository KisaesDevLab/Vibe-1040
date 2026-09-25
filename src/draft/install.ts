/**
 * Staging an engine upgrade for a human to approve (QUESTIONS.md Q23).
 *
 * The first answer to "should upgrading the engine be a button" was no, on the grounds that
 * §14's pin-and-checksum rule exists so nothing at runtime can move the version. That answer was
 * reversed, twice, and this is the shape that keeps the rule intact: **staging is not
 * installing**. A candidate is fetched, its digest verified before it is ever executed, run once
 * for its version, and checked against the node map — and then it sits there. Nothing is served
 * by it until a person reads that report and presses activate.
 *
 * So what an operator gains is the tedious half done for them and the dangerous half still
 * theirs. What §14 loses is nothing: there is no `latest`, no `install.sh | sh`, and no path by
 * which the running system chooses its own engine.
 *
 * **Off unless the deployment configured it.** The sidecar needs a writable volume on a
 * container that ships `read_only: true`, and the download form needs outbound access from the
 * appliance to the release host. Neither exists by default and both belong in the WISP review
 * Q21 opened, so `stagedState().allowed` is false until somebody provides them — and the page
 * says why rather than showing buttons that cannot work.
 *
 * **The check that matters is the catalogue one.** A renamed *optional* field is accepted by the
 * engine and ignored, so the amount vanishes and the line reads as absent — the silent omission
 * this app exists to prevent. Running that check against the staged binary, before it serves
 * anything, is the whole reason staging is worth building rather than just documenting.
 */
import {
  activateStaged as activateOnSidecar,
  discardStaged as discardOnSidecar,
  fetchStagedCatalog,
  rollbackEngine as rollbackOnSidecar,
  stageRelease as stageOnSidecar,
  stagedState as stagedStateOnSidecar,
  type StagedEngineState,
  type StagedRelease,
} from './client.ts';
import { checkAgainstCatalog, formatFindings, mappedNodeTypes, type CatalogCheck } from './catalog.ts';
import { resolveNodeMap } from './nodes.ts';

export interface StagedReport {
  state: StagedEngineState;
  /**
   * The node map checked against the **staged** binary's own field catalogue.
   *
   * Null when nothing is staged, or when there is no node map to check against. A blocking
   * finding here is the reason not to activate; an advisory one is worth reading first.
   */
  check: CatalogCheck | null;
  /** One line per finding, in the order a person should read them. */
  findings: string[];
  /** The node map this was checked against, so a report cannot be read against the wrong season. */
  nodeMap: { taxYear: number; version: string } | null;
}

/** What is staged and what is live, with the staged binary checked against the node map. */
export async function stagedReport(taxYear?: number): Promise<StagedReport> {
  const state = await stagedStateOnSidecar();
  const resolved = await resolveNodeMap(taxYear ?? Number.NaN);
  const nodeMap = resolved ? { taxYear: resolved.year, version: resolved.file.version } : null;

  if (!state.allowed || state.staged === null || resolved === null) {
    return { state, check: null, findings: [], nodeMap };
  }

  const catalog = await fetchStagedCatalog(mappedNodeTypes(resolved.file));
  const check = checkAgainstCatalog(resolved.file, catalog);
  return { state, check, findings: formatFindings(check), nodeMap };
}

/**
 * Stage a named release, then immediately check it against the node map.
 *
 * The two are one operation from a caller's point of view on purpose: a staged binary nobody
 * has checked is worse than no staged binary, because it looks ready. If the catalogue check
 * cannot run the staging still stands — the report says so and the reason is visible — but the
 * happy path never ends with an unchecked candidate sitting in the staging directory.
 */
export async function stageAndCheck(
  // `| undefined` spelled out under `exactOptionalPropertyTypes`: a zod-parsed body has the key
  // present and undefined, which is the same thing over JSON and a different type here.
  spec: { version: string; sha256: string; url?: string | undefined; file?: string | undefined },
  taxYear?: number,
): Promise<{ staged: StagedRelease; report: StagedReport }> {
  const staged = await stageOnSidecar(spec);
  return { staged, report: await stagedReport(taxYear) };
}

/**
 * Make the staged binary live.
 *
 * Deliberately **does not** re-run the catalogue check first. A caller that wanted the check
 * has already seen it in the report, and silently refusing here on a finding the operator has
 * read and decided about would be the app overruling a person on their own appliance. What it
 * does guarantee is that the previous binary is kept, so the fastest fix for a bad upgrade is
 * one more button rather than a rebuild.
 */
export async function activateStagedEngine(): Promise<{ version: string; path: string }> {
  return activateOnSidecar();
}

export async function rollbackStagedEngine(): Promise<{ version: string; path: string }> {
  return rollbackOnSidecar();
}

export async function discardStagedEngine(): Promise<{ discarded: boolean }> {
  return discardOnSidecar();
}
