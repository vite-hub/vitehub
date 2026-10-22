import type { Snapshot } from "./inbox/store.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

/** GitHub REST reads, as GitHub returns them. */
export interface BaseFreshnessReader {
  /** The items of every page of a list. `key` names the field that holds the list, such as `check_runs`. */
  rest(path: string, signal: AbortSignal, key?: string): Promise<unknown[]>;
  /** The first page only. */
  page(path: string, signal: AbortSignal): Promise<unknown>;
}

/** Files the comparison may list before it counts as truncated. GitHub caps this at 300. */
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
  const runs = await Promise.all(runIds.map(async (id) => {
    const run = await reader.page(`repos/${repository}/actions/runs/${id}`, signal);
    if (!isRuntimeRecord(run)) return { created: Number.NaN, base: undefined, hasPullRequestMetadata: false };
    const bases = Array.isArray(run.pull_requests)
      ? run.pull_requests.map(pr => isRuntimeRecord(pr) && isRuntimeRecord(pr.base) ? pr.base.sha : undefined).filter((base): base is string => hasRuntimeType(base, "string"))
      : [];
    // An array returned by the Actions API is metadata, even when it is
    // empty or contains unusable entries. In that case the run is
    // ambiguous and must not fall back to an activity timestamp guess.
    return { created: Date.parse(String(run.created_at)), base: bases.length === 1 ? bases[0] : undefined, hasPullRequestMetadata: Array.isArray(run.pull_requests) };
  }));
  // A non-PR or ambiguous run is never evidence for the PR's tested base.
  const exactBases = runs.filter(run => run.hasPullRequestMetadata).map(run => run.base);
  if (exactBases.length && exactBases.some(base => !base)) return undefined;
  const exact = runs.slice().sort((a, b) => a.created - b.created).find(run => run.hasPullRequestMetadata && run.base)?.base;
  if (exact) return exact;
  const started = runs.map(run => run.created);
  const ranAt = Math.min(...started.filter(Number.isFinite));
  if (!Number.isFinite(ranAt)) return undefined;
  const activity = await reader.page(`repos/${repository}/activity?ref=${encodeURIComponent(`refs/heads/${baseRef}`)}&per_page=100`, signal);
  // Activity lists the newest push first. GitHub timestamps have whole seconds.
  const cutoff = Math.floor((ranAt - pushMarginMs) / 1000) * 1000;
  const push = Array.isArray(activity) ? activity.find(item => isRuntimeRecord(item) && Date.parse(String(item.timestamp)) <= cutoff) : undefined;
  return isRuntimeRecord(push) && hasRuntimeType(push.after, "string") ? push.after : undefined;
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
    reader.rest(`repos/${repository}/pulls/${number}/files?per_page=100`, signal),
    checksTestedBase(reader, snapshot, live.head.sha, live.base.ref, new Set(["success"]), signal),
  ]);
  const changed = new Set(files.flatMap(file => isRuntimeRecord(file) ? [file.filename, file.previous_filename] : []).filter(file => hasRuntimeType(file, "string")));
  // Without an exact Actions run base, checks do not prove that the current
  // base was tested. Force a retest before allowing a direct merge.
  if (!testedBase) return [...changed];
  // The first page has the complete file list; later pages only add commits.
  const compare = await reader.page(`repos/${repository}/compare/${testedBase}...${encodeURIComponent(live.base.ref)}?per_page=100`, signal);
  if (!isRuntimeRecord(compare) || !compare.ahead_by) return [];
  // GitHub exposes at most 300 files for a comparison. Each response item is
  // one changed file, so renamed files and null previous names do not inflate
  // the truncation count.
  if (!Array.isArray(compare.files) || compare.files.length >= 100) return [...changed];
  const baseFiles = compare.files.flatMap(file => isRuntimeRecord(file) ? [file.filename, file.previous_filename] : []);
  return [...new Set(baseFiles.filter((file): file is string => hasRuntimeType(file, "string") && changed.has(file)))];
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
  const compare = await reader.page(`repos/${snapshot.repository}/compare/${testedBase}...${encodeURIComponent(baseRef)}?per_page=${compareFileLimit}`, signal);
  if (!isRuntimeRecord(compare) || !hasRuntimeType(compare.ahead_by, "number") || !compare.ahead_by) return undefined;
  // While the base itself fails, the update inherits the same failures.
  const [baseChecks, baseStatuses] = await Promise.all([
    reader.rest(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/check-runs?per_page=100`, signal, "check_runs"),
    reader.rest(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/statuses?per_page=100`, signal),
  ]);
  const failedSet = new Set([...failed].map(value => value.toLowerCase()));
  // Statuses list the newest first; only the latest state of each context counts.
  const latestStatuses = new Map<string, string>();
  for (const value of baseStatuses) {
    if (isRuntimeRecord(value) && hasRuntimeType(value.context, "string") && hasRuntimeType(value.state, "string") && !latestStatuses.has(value.context)) latestStatuses.set(value.context, value.state);
  }
  return baseChecks.some(check => isRuntimeRecord(check) && hasRuntimeType(check.conclusion, "string") && failedSet.has(check.conclusion.toLowerCase()))
    || [...latestStatuses.values()].some(value => failedSet.has(value.toLowerCase()))
    ? undefined
    : compare.ahead_by;
}
