import type { Snapshot } from "./inbox/store.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

/** GitHub REST reads. `rest` follows every page; `page` reads only the first one. */
export interface BaseFreshnessReader {
  rest(path: string, projection: string, signal: AbortSignal): Promise<unknown[]>;
  page(path: string, projection: string, signal: AbortSignal): Promise<unknown>;
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
    const [run] = await reader.rest(`repos/${repository}/actions/runs/${id}`, "{created_at: .created_at, pull_requests: [.pull_requests[]? | .base.sha]}", signal);
    if (isRuntimeRecord(run)) {
      const bases = Array.isArray(run.pull_requests) ? run.pull_requests.filter((base): base is string => hasRuntimeType(base, "string")) : [];
      // An array returned by the Actions API is metadata, even when it is
      // empty or contains unusable entries. In that case the run is
      // ambiguous and must not fall back to an activity timestamp guess.
      return { created: Date.parse(String(run.created_at)), base: bases.length === 1 ? bases[0] : undefined, hasPullRequestMetadata: Array.isArray(run.pull_requests) };
    }
    // Compatibility with older readers; real GitHub responses are records above.
    return { created: Date.parse(String(run)), base: undefined, hasPullRequestMetadata: false };
  }));
  // A non-PR or ambiguous run is never evidence for the PR's tested base.
  const exactBases = runs.filter(run => run.hasPullRequestMetadata).map(run => run.base);
  if (exactBases.length && exactBases.some(base => !base)) return undefined;
  const exact = runs.slice().sort((a, b) => a.created - b.created).find(run => run.hasPullRequestMetadata && run.base)?.base;
  if (exact) return exact;
  const started = runs.map(run => run.created);
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
  // Without an exact Actions run base, checks do not prove that the current
  // base was tested. Force a retest before allowing a direct merge.
  if (!testedBase) return [...changed];
  // The first page has the complete file list; later pages only add commits.
  const compare = await reader.page(`repos/${repository}/compare/${testedBase}...${encodeURIComponent(live.base.ref)}?per_page=100`,
    "{ahead: .ahead_by, files: [.files[]? | {filename: .filename, previous_filename: .previous_filename}]}", signal);
  if (!isRuntimeRecord(compare) || !compare.ahead) return [];
  // GitHub exposes at most 300 files for a comparison. Each response item is
  // one changed file, so renamed files and null previous names do not inflate
  // the truncation count.
  if (!Array.isArray(compare.files) || compare.files.length >= 100) return [...changed];
  const baseFiles = compare.files.flatMap(file => isRuntimeRecord(file)
    ? [file.filename, file.previous_filename]
    : Array.isArray(file) ? file : []);
  return [...new Set(baseFiles.filter(file => hasRuntimeType(file, "string") && changed.has(file)))];
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
  const compare = await reader.page(`repos/${snapshot.repository}/compare/${testedBase}...${encodeURIComponent(baseRef)}?per_page=${compareFileLimit}`, "{ahead: .ahead_by}", signal);
  if (!isRuntimeRecord(compare) || !hasRuntimeType(compare.ahead, "number") || !compare.ahead) return undefined;
  // While the base itself fails, the update inherits the same failures.
  const [baseFailures, baseStatuses] = await Promise.all([
    reader.rest(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/check-runs?per_page=100`,
      ".check_runs[]?.conclusion", signal),
    reader.rest(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/statuses?per_page=100`,
      ".[]? | {context: .context, state: .state}", signal),
  ]);
  const failedSet = new Set([...failed].map(value => value.toLowerCase()));
  const legacyFailures = baseFailures.length ? baseFailures : [await reader.page(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/check-runs?per_page=100`,
    `[.check_runs[] | select(.conclusion as $c | ${JSON.stringify([...failed])} | index($c))] | length`, signal)];
  const legacyStatuses = baseStatuses.length ? baseStatuses : [await reader.page(`repos/${snapshot.repository}/commits/${encodeURIComponent(baseRef)}/statuses?per_page=100`,
    `[.[] | select(.state as $s | ${JSON.stringify([...failed])} | index($s))] | length`, signal)];
  const latestStatuses = new Map<string, string>();
  for (const value of legacyStatuses) {
    if (isRuntimeRecord(value) && hasRuntimeType(value.context, "string") && hasRuntimeType(value.state, "string") && !latestStatuses.has(value.context)) latestStatuses.set(value.context, value.state);
  }
  return legacyFailures.some(value => hasRuntimeType(value, "string") && failedSet.has(value.toLowerCase()))
    || (latestStatuses.size ? [...latestStatuses.values()].some(value => failedSet.has(value.toLowerCase())) : legacyStatuses.some(value => hasRuntimeType(value, "string") && failedSet.has(value.toLowerCase())))
    || legacyFailures.some(value => typeof value === "number" && value > 0)
    || legacyStatuses.some(value => typeof value === "number" && value > 0)
    ? undefined
    : compare.ahead;
}
