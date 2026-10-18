import type { Snapshot } from "./inbox/store.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

/** GitHub REST reads. `rest` follows every page; `page` reads only the first one. */
export interface BaseFreshnessReader {
  rest(path: string, projection: string, signal: AbortSignal): Promise<unknown[]>;
  page(path: string, projection: string, signal: AbortSignal): Promise<unknown>;
}

/** Files the comparison may list before it counts as truncated. GitHub stops at 300. */
const compareFileLimit = 300;
/** Pushes this close to the run start may not be in the run's checkout. */
const pushMarginMs = 2 * 60_000;

/**
 * The base tip that the earliest Actions run behind the selected current-head checks tested: the last
 * push to the base before that run started. Commit dates cannot tell, because a pushed branch keeps
 * its older dates. Undefined when no run qualifies or the push is older than the activity page.
 */
export async function checksTestedBase(reader: BaseFreshnessReader, snapshot: Snapshot, head: string, baseRef: string, conclusions: ReadonlySet<string>, signal: AbortSignal): Promise<string | undefined> {
  const { repository } = snapshot;
  const runIds = [...new Set(Object.values(snapshot.checks).flatMap((check) => {
    if (check.deleted || check.head_sha !== head || !conclusions.has(String(check.conclusion).toLowerCase())) return [];
    const id = String(check.html_url ?? check.details_url ?? "").match(/\/actions\/runs\/(\d+)/)?.[1];
    return id ? [id] : [];
  }))];
  const started = await Promise.all(runIds.map(async (id) => {
    const [created] = await reader.rest(`repos/${repository}/actions/runs/${id}`, ".created_at", signal);
    return Date.parse(String(created));
  }));
  const ranAt = Math.min(...started.filter(Number.isFinite));
  if (!Number.isFinite(ranAt)) return undefined;
  const tested = await reader.page(`repos/${repository}/activity?ref=${encodeURIComponent(`refs/heads/${baseRef}`)}&per_page=100`,
    `[.[] | select((.timestamp | fromdate) <= ${Math.floor((ranAt - pushMarginMs) / 1000)})][0].after`, signal);
  return hasRuntimeType(tested, "string") ? tested : undefined;
}

/**
 * Files the PR changes that its base branch also changed after the PR's checks ran. PR checks test
 * the base of that moment, so two PRs that edit the same file can each pass and still break the base
 * together. Empty means nothing overlaps. Any doubt (no Actions run, a truncated comparison) returns
 * every changed file, so the PR is updated and tested against the current base.
 */
export async function staleBaseOverlap(reader: BaseFreshnessReader, snapshot: Snapshot, live: { head: { sha: string }; base: { ref: string } }, signal: AbortSignal): Promise<string[]> {
  const { repository, number } = snapshot;
  const [files, testedBase] = await Promise.all([
    reader.rest(`repos/${repository}/pulls/${number}/files?per_page=100`, ".[] | [.filename, .previous_filename]", signal),
    checksTestedBase(reader, snapshot, live.head.sha, live.base.ref, new Set(["success"]), signal),
  ]);
  const changed = new Set(files.flatMap(entry => Array.isArray(entry) ? entry : [entry]).filter(file => hasRuntimeType(file, "string")));
  if (!testedBase) return [...changed];
  // The first page has the complete file list; later pages only add commits.
  const compare = await reader.page(`repos/${repository}/compare/${testedBase}...${encodeURIComponent(live.base.ref)}?per_page=1`,
    "{ahead: .ahead_by, files: [.files[]? | .filename, .previous_filename]}", signal);
  if (!isRuntimeRecord(compare) || !compare.ahead) return [];
  if (!Array.isArray(compare.files) || compare.files.length >= compareFileLimit) return [...changed];
  return [...new Set(compare.files.filter(file => hasRuntimeType(file, "string") && changed.has(file)))];
}

/**
 * Commits the base gained after failed checks ran, when the base tip itself has no failing check.
 * A broken base fails every PR that tests against it; after the base is fixed, an update makes most
 * of them pass without a model pass. Undefined when the failures ran on the current base.
 */
export async function baseFixedSinceFailure(reader: BaseFreshnessReader, snapshot: Snapshot, failed: ReadonlySet<string>, signal: AbortSignal): Promise<number | undefined> {
  const pr = snapshot.pr;
  const head = pr?.head?.sha;
  const baseRef = pr?.base?.ref;
  if (!head || !baseRef) return undefined;
  const testedBase = await checksTestedBase(reader, snapshot, head, baseRef, failed, signal);
  if (!testedBase) return undefined;
  const compare = await reader.page(`repos/${snapshot.repository}/compare/${testedBase}...${encodeURIComponent(baseRef)}?per_page=1`, "{ahead: .ahead_by}", signal);
  if (!isRuntimeRecord(compare) || !hasRuntimeType(compare.ahead, "number") || !compare.ahead) return undefined;
  // While the base itself fails, the update inherits the same failures.
  const baseFailures = await reader.page(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/check-runs?per_page=100`,
    `[.check_runs[] | select(.conclusion as $c | ${JSON.stringify([...failed])} | index($c))] | length`, signal);
  return baseFailures === 0 ? compare.ahead : undefined;
}
