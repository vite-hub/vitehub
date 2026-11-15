import * as v from "valibot";

/**
 * Opens a pull request that repairs the default branch when one of its watched workflows fails. PR
 * checks often run only fast suites while the full suites run on the default branch, so pull requests
 * that each pass can break it together. The repair PR's head branch starts with
 * `mainRepairBranchPrefix`, so the queue claims it first.
 */
export interface BabysitterMainRepair {
  /** GitHub Actions workflow names to watch on the default branch, such as `["ci"]`. */
  workflows: string[];
  /** Repositories to watch, as `owner/name`. Defaults to every repository the Babysitter serves. */
  repositories?: string[];
  /**
   * Minutes after which a running job of a watched push run on the default branch counts as stuck;
   * its run is force-cancelled so later runs can start. `false` never cancels. Defaults to 90.
   */
  stuckJobMinutes?: number | false;
}

/** GitHub REST calls with the repository's credentials. `read` returns undefined for a 404. */
export interface MainRepairGitHub {
  read(path: string, query?: Record<string, string | number>): Promise<unknown>;
  write(path: string, body?: Record<string, unknown>): Promise<unknown>;
}

export type MainRepairOutcome =
  | { state: "green"; head: string }
  | { state: "waiting"; head: string; reason: "ci-running" | "no-ci-run" }
  | { state: "repair-open"; head: string; pullRequest: number }
  | { state: "already-attempted"; head: string; red: string; branch: string }
  | { state: "opened"; head: string; red: string; branch: string; pullRequest: number; jobs: string[] };

const defaultStuckJobMinutes = 90;

const branchSchema = v.looseObject({ name: v.string(), commit: v.looseObject({ sha: v.string(), commit: v.looseObject({ tree: v.looseObject({ sha: v.string() }) }) }) });
const repositorySchema = v.looseObject({ default_branch: v.string() });
const runSchema = v.looseObject({
  id: v.number(), name: v.nullish(v.string()), head_sha: v.string(), status: v.nullish(v.string()), conclusion: v.nullish(v.string()),
  created_at: v.string(), html_url: v.string(),
});
const runsSchema = v.looseObject({ workflow_runs: v.array(runSchema) });
const jobsSchema = v.looseObject({ jobs: v.array(v.looseObject({ name: v.string(), status: v.nullish(v.string()), conclusion: v.nullish(v.string()), started_at: v.nullish(v.string()), html_url: v.nullish(v.string()) })) });
const pullsSchema = v.array(v.looseObject({ number: v.number(), merged_at: v.nullish(v.string()), head: v.looseObject({ ref: v.string(), repo: v.nullish(v.looseObject({ full_name: v.string() })) }) }));
const createdSchema = v.looseObject({ sha: v.string() });
const pullSchema = v.looseObject({ number: v.number() });

type Run = v.InferOutput<typeof runSchema>;

/** Whether a delivery is a finished, failed push run of a watched workflow on the repository's default branch. */
export function isFailedBaseRun(event: string, payload: unknown, workflows: readonly string[]): boolean {
  if (event !== "workflow_run") return false;
  const parsed = v.safeParse(v.looseObject({
    action: v.string(),
    workflow_run: v.looseObject({ name: v.nullish(v.string()), event: v.string(), head_branch: v.nullish(v.string()), conclusion: v.nullish(v.string()) }),
    repository: v.looseObject({ default_branch: v.string() }),
  }), payload);
  if (!parsed.success) return false;
  const { action, workflow_run: run, repository } = parsed.output;
  return action === "completed" && run.event === "push" && run.conclusion === "failure"
    && run.head_branch === repository.default_branch && workflows.includes(run.name ?? "");
}

/** Host-owned repair authorization; PR titles and bodies cannot enable this mode. */
export function mainRepairWorkerContext(input: { enabled: boolean; repository: string; sourceRepository?: string; branch: string; prefix?: string; base: string; defaultBranch?: unknown }): string {
  if (!input.enabled || !input.prefix || input.sourceRepository?.toLowerCase() !== input.repository.toLowerCase()
    || !input.branch.startsWith(input.prefix) || input.base !== input.defaultBranch) return "";
  return "\n\n<verified-main-repair>\nThe host verified this same-repository repair branch targets the watched repository's default branch. Repair inherited base failures, including when the initial tree equals the base tree.\n</verified-main-repair>";
}

/**
 * Checks the default branch of one repository and opens one repair PR when a watched workflow failed.
 * It first force-cancels watched push runs with a stuck job. One repair PR is open at a time, and a red
 * commit gets one repair PR. An orphan branch is reused after a failed PR creation request.
 */
export async function repairBaseBranch(
  github: MainRepairGitHub,
  options: { repository: string; branchPrefix: string; mainRepair: BabysitterMainRepair; now?: number; event?: (name: string, properties: Record<string, unknown>) => void },
): Promise<MainRepairOutcome> {
  const { repository, branchPrefix, mainRepair, now = Date.now() } = options;
  const workflows = new Set(mainRepair.workflows);
  const watched = (run: Run) => workflows.has(run.name ?? "");
  const event = (name: string, properties: Record<string, unknown>) => options.event?.(`babysitter.main_repair.${name}`, { repository, ...properties });
  const repairPull = (pull: v.InferOutput<typeof pullsSchema>[number]) =>
    pull.head.ref.startsWith(branchPrefix) && pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase();

  const base = v.parse(repositorySchema, await github.read(`repos/${repository}`)).default_branch;
  const tip = v.parse(branchSchema, await github.read(`repos/${repository}/branches/${encodeURIComponent(base)}`));
  const head = tip.commit.sha;

  // A push run on the default branch waits behind the one in progress. A job whose runner vanished kept
  // a run in progress for 9.5 hours on vite-hub/vitehub, and every later run stayed pending.
  const stuckJobMinutes = mainRepair.stuckJobMinutes ?? defaultStuckJobMinutes;
  if (stuckJobMinutes !== false) {
    const running = v.parse(runsSchema, await github.read(`repos/${repository}/actions/runs`, { branch: base, event: "push", status: "in_progress", per_page: 20 }));
    for (const run of running.workflow_runs.filter(watched)) {
      const jobs = v.parse(jobsSchema, await github.read(`repos/${repository}/actions/runs/${run.id}/jobs`, { filter: "latest", per_page: 100 })).jobs;
      const stuck = jobs.filter(job => job.status === "in_progress" && job.started_at && now - Date.parse(job.started_at) > stuckJobMinutes * 60_000);
      if (!stuck.length) continue;
      try {
        await github.write(`repos/${repository}/actions/runs/${run.id}/force-cancel`);
        event("cancelled_stuck", { run: run.id, head_sha: run.head_sha, jobs: stuck.map(job => job.name) });
      } catch (error) {
        event("cancel_stuck_failed", { run: run.id, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
  }

  const runs = v.parse(runsSchema, await github.read(`repos/${repository}/actions/runs`, { branch: base, event: "push", head_sha: head, per_page: 20 })).workflow_runs.filter(watched);
  let failed = runs.find(run => run.status === "completed" && run.conclusion === "failure");
  // The branch moves faster than its CI finishes, and a newer push cancels the queued run, so the tip
  // rarely has a finished run. Fall back to the newest finished run of each watched workflow that
  // started after the last repair PR merged.
  if (!failed) {
    const closed = v.parse(pullsSchema, await github.read(`repos/${repository}/pulls`, { state: "closed", base, sort: "updated", direction: "desc", per_page: 50 }));
    const repairedAt = Math.max(0, ...closed.filter(pull => repairPull(pull) && pull.merged_at).map(pull => Date.parse(pull.merged_at!)));
    const finished = v.parse(runsSchema, await github.read(`repos/${repository}/actions/runs`, { branch: base, event: "push", status: "completed", per_page: 100 })).workflow_runs
      .filter(run => watched(run) && !["cancelled", "skipped"].includes(run.conclusion ?? "") && Date.parse(run.created_at) > repairedAt);
    failed = mainRepair.workflows.flatMap(name => finished.find(run => run.name === name) ?? []).find(run => run.conclusion === "failure");
  }
  if (!failed) {
    if (!runs.length || runs.some(run => run.status !== "completed")) {
      event("waiting", { head, reason: runs.length ? "ci-running" : "no-ci-run" });
      return { state: "waiting", head, reason: runs.length ? "ci-running" : "no-ci-run" };
    }
    event("green", { head });
    return { state: "green", head };
  }

  // One repair at a time: an open repair PR already works on the default branch.
  const open = v.parse(pullsSchema, await github.read(`repos/${repository}/pulls`, { state: "open", base, per_page: 100 })).find(repairPull);
  if (open) {
    event("repair_open", { head, pull_request: open.number });
    return { state: "repair-open", head, pullRequest: open.number };
  }
  const red = failed.head_sha;
  const branch = `${branchPrefix}${red.slice(0, 8)}`;
  // Query all states by exact head before retrying an ambiguous create response. Closed and merged
  // PRs consume the attempt; a ref alone does not prove a PR was ever created.
  const previous = v.parse(pullsSchema, await github.read(`repos/${repository}/pulls`, { state: "all", head: `${repository.split("/")[0]}:${branch}`, per_page: 100 }))
    .find(pull => repairPull(pull) && pull.head.ref === branch);
  if (previous) {
    event("already_attempted", { head, red, branch });
    return { state: "already-attempted", head, red, branch };
  }
  const existingBranch = await github.read(`repos/${repository}/git/ref/heads/${branch}`) !== undefined;

  const jobs = v.parse(jobsSchema, await github.read(`repos/${repository}/actions/runs/${failed.id}/jobs`, { filter: "latest", per_page: 100 })).jobs.filter(job => job.conclusion === "failure");
  const body = `${base} is red at ${red}: the \`${failed.name}\` run ${failed.html_url} failed.

Failed jobs:
${jobs.map(job => job.html_url ? `- [${job.name}](${job.html_url})` : `- ${job.name}`).join("\n") || "- (see the run)"}

This PR starts with an empty commit. Read the failures with readBaseCheckEvidence and readBaseCheckLogs, reproduce them with focused tests, fix every failed job on this branch, and push the repair. It merges only once every job that failed on ${base} passes here. Do not report reviewedHead while the branch has no changes.

Opened automatically by the Babysitter.`;
  if (!existingBranch) {
    const commit = v.parse(createdSchema, await github.write(`repos/${repository}/git/commits`, { message: `chore: start ${base} repair for ${red.slice(0, 8)}`, tree: tip.commit.commit.tree.sha, parents: [head] }));
    await github.write(`repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  const pull = v.parse(pullSchema, await github.write(`repos/${repository}/pulls`, { title: `fix: repair ${base} after ${red.slice(0, 8)}`, head: branch, base, body }));
  event("opened", { head, red, branch, pull_request: pull.number, jobs: jobs.map(job => job.name) });
  return { state: "opened", head, red, branch, pullRequest: pull.number, jobs: jobs.map(job => job.name) };
}
