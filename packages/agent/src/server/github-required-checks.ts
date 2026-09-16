import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
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
export type GitHubCheckPolicyResponse = { status: number; data?: unknown };
export type GitHubReadCheckPolicy = (path: string) => Promise<GitHubCheckPolicyResponse>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  isRuntimeRecord(value) && !Array.isArray(value) ? value : undefined;
const appId = (value: unknown): number | null => {
  if (value === undefined || value === null || value === -1) return null;
  if (!hasRuntimeType(value, "number") || !Number.isInteger(value) || value < 0)
    throw new Error("Invalid required-check integration ID");
  return value;
};
function check(value: unknown, source: "rule" | "classic"): GitHubRequiredCheck {
  const item = record(value);
  if (!item || !hasRuntimeType(item.context, "string") || !item.context.trim())
    throw new Error("Incomplete required-check context");
  return {
    context: item.context,
    appId: appId(source === "rule" ? item.integration_id : item.app_id),
  };
}
function rulesChecks(data: unknown): GitHubRequiredCheck[] {
  if (!Array.isArray(data)) throw new Error("Incomplete active branch rules response");
  return data.flatMap((value) => {
    const rule = record(value);
    if (!rule || !hasRuntimeType(rule.type, "string"))
      throw new Error("Incomplete active branch rule");
    if (rule.type === "workflows" || rule.type === "required_workflows")
      throw new Error("Required workflow rules cannot be reduced to check contexts");
    if (rule.type !== "required_status_checks") return [];
    const parameters = record(rule.parameters);
    if (!Array.isArray(parameters?.required_status_checks))
      throw new Error("Incomplete ruleset required-check parameters");
    return parameters.required_status_checks.map((item: unknown) => check(item, "rule"));
  });
}
function classicChecks(data: unknown): GitHubRequiredCheck[] {
  const policy = record(data);
  if (
    !policy ||
    !Array.isArray(policy.contexts) ||
    (policy.checks !== undefined && !Array.isArray(policy.checks))
  )
    throw new Error("Incomplete classic status-check protection");
  const bound: GitHubRequiredCheck[] = (Array.isArray(policy.checks) ? policy.checks : []).map(
    (item: unknown) => check(item, "classic"),
  );
  for (const context of policy.contexts) {
    if (!hasRuntimeType(context, "string") || !context.trim())
      throw new Error("Incomplete classic required-check context");
    // contexts repeats the check names but loses their app binding.
    if (!bound.some((item) => item.context === context)) bound.push({ context, appId: null });
  }
  return bound;
}

export interface GitHubRequiredCheckPolicyReader {
  read(repository: string, branch: string): Promise<GitHubRequiredCheckPolicy>;
  /** Discard cached and in-flight results after a protection or ruleset change. */
  invalidate(repository?: string, branch?: string): void;
}

/** Cache authoritative policy, including explicit unknown results; never infer CI requirements from names. */
export function createGitHubRequiredCheckPolicyReader(
  read: GitHubReadCheckPolicy,
  options: { clock?: () => number; ttlMs?: number; failureTtlMs?: number } = {},
): GitHubRequiredCheckPolicyReader {
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { expires: number; value: GitHubRequiredCheckPolicy }>();
  const active = new Map<string, Promise<GitHubRequiredCheckPolicy>>();
  const request = async (path: string): Promise<GitHubCheckPolicyResponse> => {
    try {
      return await read(path);
    } catch {
      return { status: 0 };
    }
  };
  async function fetch(repository: string, branch: string): Promise<GitHubRequiredCheckPolicy> {
    const base: GitHubRequiredCheckPolicy = {
      repository,
      branch,
      status: "unknown",
      source: "github-rest-rules-and-protection",
      fetchedAt: new Date(clock()).toISOString(),
      required: [],
    };
    const prefix = `repos/${repository}`,
      encodedBranch = encodeURIComponent(branch);
    const [rules, classic] = await Promise.all([
      request(`${prefix}/rules/branches/${encodedBranch}`),
      request(`${prefix}/branches/${encodedBranch}/protection/required_status_checks`),
    ]);
    try {
      if (rules.status !== 200)
        throw new Error(`Active branch rules unavailable (HTTP ${rules.status})`);
      const required = rulesChecks(rules.data);
      let classicSource: GitHubRequiredCheckPolicy["classicSource"] = "protection-endpoint";
      if (classic.status === 200) required.push(...classicChecks(classic.data));
      else if (classic.status === 403 || classic.status === 404) {
        // Get-a-branch is documented with the complete required-status-check
        // summary (contexts + checks/app IDs) and only needs Contents:read.
        // This avoids demanding Administration:read from the worker App.
        const branchState = await request(`${prefix}/branches/${encodedBranch}`);
        const branch = record(branchState.data);
        if (branchState.status !== 200) throw new Error("Branch protection summary unavailable");
        if (branch?.protected === false) classicSource = "unprotected-branch";
        else {
          const protection = record(branch?.protection);
          const summary = record(protection?.required_status_checks);
          if (
            branch?.protected !== true ||
            protection?.enabled !== true ||
            !summary ||
            !Array.isArray(summary.contexts) ||
            !Array.isArray(summary.checks) ||
            !["everyone", "non_admins", "off"].includes(String(summary.enforcement_level))
          )
            throw new Error(
              "Classic protection response is ambiguous; branch summary is incomplete",
            );
          if (
            summary.enforcement_level === "off" &&
            (summary.contexts.length || summary.checks.length)
          )
            throw new Error("Disabled status-check summary contains ambiguous requirements");
          const checks = summary.checks;
          if (
            summary.contexts.some(
              (context) => !checks.some((item) => record(item)?.context === context),
            )
          )
            throw new Error("Branch summary omits required-check integration bindings");
          required.push(...classicChecks(summary));
          classicSource = "branch-summary";
        }
      } else throw new Error(`Classic protection unavailable (HTTP ${classic.status})`);
      return {
        ...base,
        status: "known",
        classicSource,
        required: [
          ...new Map(
            required.map((item) => [`${item.context}\0${item.appId ?? "*"}`, item]),
          ).values(),
        ],
      };
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
        .filter(
          (value) =>
            value.sha === evidence.headSha &&
            value.context === required.context &&
            required.appId === null,
        )
        .sort((a, b) => b.id - a.id)[0];
      const states: GitHubRequiredCheckState[] = [];
      if (runs[0]) states.push(stateOfCheck(runs[0]));
      // A check and commit status with the same context both have to pass.
      if (status)
        states.push(
          status.state === "pending"
            ? "pending"
            : status.state === "success"
              ? "passed"
              : ["failure", "error"].includes(status.state)
                ? "failed"
                : "unknown",
        );
      if (!states.length) missing.push(required.context);
      return {
        ...required,
        state: states.length ? combine(states) : "pending",
      };
    },
  );
  return {
    state: policy.required.length ? combine(checks.map((item) => item.state)) : "passed",
    checks,
    missing,
  };
}
function combine(states: GitHubRequiredCheckState[]): GitHubRequiredCheckState {
  if (states.includes("failed")) return "failed";
  if (!states.length || states.includes("unknown")) return "unknown";
  return states.includes("pending") ? "pending" : "passed";
}
