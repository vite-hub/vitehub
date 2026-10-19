import type { BranchRules } from "@vite-hub/forge";
export type GitHubRequiredCheck = { context: string; appId: number | null };
export type GitHubRequiredCheckPolicy = {
  repository: string;
  branch: string;
  status: "known" | "unknown";
  source: "github-rest-rules-and-protection";
  fetchedAt: string;
  required: GitHubRequiredCheck[];
  reason?: string;
  classicSource?: "protection-endpoint" | "branch-summary" | "unprotected-branch";
};
/** Read the branch rules of one branch, for example with `branchRules()` from `@vite-hub/forge`. */
export type GitHubReadBranchRules = (repository: string, branch: string) => Promise<BranchRules>;

export interface GitHubRequiredCheckPolicyReader {
  read(repository: string, branch: string): Promise<GitHubRequiredCheckPolicy>;
  /** Discard cached and in-flight results after a protection or ruleset change. */
  invalidate(repository?: string, branch?: string): void;
}

/** Cache authoritative policy, including explicit unknown results; never infer CI requirements from names. */
export function createGitHubRequiredCheckPolicyReader(
  read: GitHubReadBranchRules,
  options: { clock?: () => number; ttlMs?: number; failureTtlMs?: number } = {},
): GitHubRequiredCheckPolicyReader {
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { expires: number; value: GitHubRequiredCheckPolicy }>();
  const active = new Map<string, Promise<GitHubRequiredCheckPolicy>>();
  async function fetch(repository: string, branch: string): Promise<GitHubRequiredCheckPolicy> {
    const base: GitHubRequiredCheckPolicy = {
      repository,
      branch,
      status: "unknown",
      source: "github-rest-rules-and-protection",
      fetchedAt: new Date(clock()).toISOString(),
      required: [],
    };
    try {
      const rules = await read(repository, branch);
      if (rules.requiredWorkflows) throw new Error("Required workflow rules cannot be reduced to check contexts");
      return { ...base, status: "known", classicSource: rules.classicSource, required: rules.requiredChecks };
    } catch (error) {
      return {
        ...base,
        reason: error instanceof Error ? error.message : "Required-check policy unavailable",
      };
    }
  }
  const readPolicy = async (
    repository: string,
    branch: string,
  ): Promise<GitHubRequiredCheckPolicy> => {
    const key = `${repository.toLowerCase()}\0${branch}`;
    const cached = cache.get(key);
    if (cached && cached.expires > clock()) return structuredClone(cached.value);
    let pending = active.get(key);
    if (!pending) {
      pending = fetch(repository, branch)
        .then((value) => {
          if (active.get(key) === pending)
            cache.set(key, {
              value,
              expires:
                clock() +
                (value.status === "known"
                  ? (options.ttlMs ?? 300_000)
                  : (options.failureTtlMs ?? 120_000)),
            });
          return value;
        })
        .finally(() => {
          if (active.get(key) === pending) active.delete(key);
        });
      active.set(key, pending);
    }
    return structuredClone(await pending);
  };
  return {
    read: readPolicy,
    /** Discard cached and in-flight results. Call after a protection or ruleset change. */
    invalidate(repository?: string, branch?: string) {
      for (const key of new Set([...cache.keys(), ...active.keys()])) {
        const [repo, ref] = key.split("\0");
        if (
          (!repository || repo === repository.toLowerCase()) &&
          (branch === undefined || ref === branch)
        ) {
          cache.delete(key);
          active.delete(key);
        }
      }
    },
  };
}

export type GitHubRequiredCheckState = "pending" | "failed" | "passed" | "unknown";
export interface GitHubCheckEvidence {
  repository: string;
  branch: string;
  headSha: string;
  /** Complete check-run records and commit statuses annotated with the queried SHA. */
  checkRuns: ReadonlyArray<GitHubCheckRun>;
  statuses: ReadonlyArray<GitHubCommitStatus>;
}
export interface GitHubCheckRun {
  id: number;
  head_sha: string;
  name: string;
  app?: { id: number } | null;
  status: string;
  conclusion?: string | null;
  started_at?: string | null;
  created_at?: string | null;
}
export interface GitHubCommitStatus {
  id: number;
  /** Exact SHA used to fetch this status; GitHub REST status records omit it. */
  sha: string;
  context: string;
  state: string;
  created_at?: string | null;
}
const stateOfCheck = (value: GitHubCheckRun): GitHubRequiredCheckState => {
  if (
    ["queued", "in_progress", "pending", "waiting", "requested"].includes(
      value.status.toLowerCase(),
    )
  )
    return "pending";
  if (value.status.toLowerCase() !== "completed") return "unknown";
  const conclusion = value.conclusion?.toLowerCase() ?? "";
  if (["success", "neutral", "skipped"].includes(conclusion)) return "passed";
  return [
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
  ].includes(conclusion)
    ? "failed"
    : "unknown";
};

/** Scheduling evidence only. Cached policy and check results never authorize a merge. */
export function evaluateGitHubRequiredChecks(
  policy: GitHubRequiredCheckPolicy,
  evidence: GitHubCheckEvidence,
): {
  state: GitHubRequiredCheckState;
  checks: Array<GitHubRequiredCheck & { state: GitHubRequiredCheckState }>;
  missing: string[];
} {
  if (
    policy.status !== "known" ||
    policy.repository.toLowerCase() !== evidence.repository.toLowerCase() ||
    policy.branch !== evidence.branch ||
    !evidence.headSha
  )
    return { state: "unknown", checks: [], missing: [] };
  const missing: string[] = [];
  const checks = policy.required.map(
    (required): GitHubRequiredCheck & { state: GitHubRequiredCheckState } => {
      const runs = evidence.checkRuns
        .filter(
          (value) =>
            value.head_sha === evidence.headSha &&
            value.name === required.context &&
            (required.appId === null || value.app?.id === required.appId),
        )
        .sort((a, b) => b.id - a.id);
      const status = evidence.statuses
        .filter((value) => value.sha === evidence.headSha && value.context === required.context)
        .sort((a, b) => b.id - a.id)[0];
      const states: GitHubRequiredCheckState[] = [];
      if (runs[0]) states.push(stateOfCheck(runs[0]));
      // Both record types must pass. REST statuses cannot prove their source App.
      if (status)
        states.push(
          status.state === "pending"
            ? "pending"
            : ["failure", "error"].includes(status.state)
              ? "failed"
              : status.state === "success" && required.appId === null
                ? "passed"
                : "unknown",
        );
      if (!states.length) missing.push(required.context);
      return {
        ...required,
        state: states.length ? combine(states) : "pending",
      };
    },
  );
  // Without required checks, every current-head check gates the merge while it runs.
  // Failures do not block here; the merge gate asks for their assessment.
  const newest = new Map<string, GitHubCheckRun>();
  for (const value of evidence.checkRuns) {
    if (value.head_sha !== evidence.headSha) continue;
    const key = `${value.name}\0${value.app?.id ?? ""}`;
    const previous = newest.get(key);
    if (!previous || value.id > previous.id) newest.set(key, value);
  }
  const running =
    [...newest.values()].some((value) => stateOfCheck(value) === "pending") ||
    evidence.statuses.some((value) => value.sha === evidence.headSha && value.state === "pending");
  return {
    state: policy.required.length
      ? combine(checks.map((item) => item.state))
      : running
        ? "pending"
        : "passed",
    checks,
    missing,
  };
}
function combine(states: GitHubRequiredCheckState[]): GitHubRequiredCheckState {
  if (states.includes("failed")) return "failed";
  if (!states.length || states.includes("unknown")) return "unknown";
  return states.includes("pending") ? "pending" : "passed";
}
