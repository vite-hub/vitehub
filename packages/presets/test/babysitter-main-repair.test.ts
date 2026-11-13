import { describe, expect, it, vi } from "vitest";
import { codexDriver, defineAgent } from "@vite-hub/agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { babysitter } from "../src/babysitter.ts";
import { isFailedBaseRun, repairBaseBranch, type BabysitterMainRepair, type MainRepairGitHub } from "../src/babysitter/main-repair.ts";
import { createBabysitterRuntime } from "../src/babysitter/server.ts";
import type { GitHubHost } from "../src/github/index.ts";
import { githubForge } from "./fixtures/github-forge.ts";

const repository = "acme/app";
const tip = "a".repeat(40);
const older = "b".repeat(40);
const prefix = "repair-main-";
const now = Date.parse("2026-11-13T12:00:00Z");

interface Run { id: number; name: string; head_sha: string; status: string; conclusion: string | null; created_at: string; html_url: string }
const run = (id: number, name: string, head: string, conclusion: string | null, created = "2026-11-13T11:00:00Z"): Run => ({
  id, name, head_sha: head, status: conclusion === null ? "in_progress" : "completed", conclusion, created_at: created, html_url: `https://github.com/${repository}/actions/runs/${id}`,
});
const pull = (number: number, ref: string, mergedAt?: string, owner = repository) => ({ number, merged_at: mergedAt ?? null, head: { ref, repo: { full_name: owner } } });

/** A GitHub with one default branch. Each list is what GitHub returns for the matching query. */
function fakeGitHub(state: {
  runs?: Run[];
  jobs?: Record<number, { name: string; status: string; conclusion: string | null; started_at: string; html_url?: string }[]>;
  openPulls?: ReturnType<typeof pull>[];
  closedPulls?: ReturnType<typeof pull>[];
  branches?: string[];
}) {
  const writes: { path: string; body?: Record<string, unknown> }[] = [];
  const github: MainRepairGitHub = {
    async read(path, query = {}) {
      if (path === `repos/${repository}`) return { default_branch: "main" };
      if (path === `repos/${repository}/branches/main`) return { name: "main", commit: { sha: tip, commit: { tree: { sha: "t".repeat(40) } } } };
      if (path === `repos/${repository}/actions/runs`) {
        const runs = (state.runs ?? []).filter(item => (query.head_sha === undefined || item.head_sha === query.head_sha)
          && (query.status === undefined || item.status === query.status));
        return { total_count: runs.length, workflow_runs: runs };
      }
      const jobs = /actions\/runs\/(\d+)\/jobs$/.exec(path);
      if (jobs) return { jobs: state.jobs?.[Number(jobs[1])] ?? [] };
      if (path === `repos/${repository}/pulls`) return query.state === "open" ? state.openPulls ?? [] : state.closedPulls ?? [];
      const ref = /git\/ref\/heads\/(.+)$/.exec(path);
      if (ref) return state.branches?.includes(ref[1]!) ? { ref: `refs/heads/${ref[1]}` } : undefined;
      throw new Error(`Unexpected read ${path}`);
    },
    async write(path, body) {
      writes.push({ path, body });
      if (path.endsWith("/git/commits")) return { sha: "e".repeat(40) };
      if (path.endsWith("/git/refs")) return { ref: body?.ref };
      if (path.endsWith("/pulls")) return { number: 77 };
      return {};
    },
  };
  return { github, writes };
}

const mainRepair: BabysitterMainRepair = { workflows: ["ci", "pkg.pr.new"] };

async function check(state: Parameters<typeof fakeGitHub>[0], options: Partial<BabysitterMainRepair> = {}) {
  const { github, writes } = fakeGitHub(state);
  const event = vi.fn();
  const outcome = await repairBaseBranch(github, { repository, branchPrefix: prefix, mainRepair: { ...mainRepair, ...options }, now, event });
  return { outcome, writes, event };
}

describe("Babysitter main repair", () => {
  it("opens a repair PR with an empty commit when a watched workflow fails on the tip", async () => {
    const { outcome, writes, event } = await check({
      runs: [run(1, "ci", tip, "failure"), run(2, "docs", tip, "failure")],
      jobs: { 1: [{ name: "test", status: "completed", conclusion: "failure", started_at: "2026-11-13T11:00:00Z", html_url: "https://example.test/job/9" }, { name: "lint", status: "completed", conclusion: "success", started_at: "2026-11-13T11:00:00Z" }] },
    });
    expect(outcome).toEqual({ state: "opened", head: tip, red: tip, branch: `${prefix}aaaaaaaa`, pullRequest: 77, jobs: ["test"] });
    expect(writes.map(write => write.path)).toEqual([`repos/${repository}/git/commits`, `repos/${repository}/git/refs`, `repos/${repository}/pulls`]);
    expect(writes[0]!.body).toEqual({ message: "chore: start main repair for aaaaaaaa", tree: "t".repeat(40), parents: [tip] });
    expect(writes[1]!.body).toEqual({ ref: `refs/heads/${prefix}aaaaaaaa`, sha: "e".repeat(40) });
    expect(writes[2]!.body).toMatchObject({ title: "fix: repair main after aaaaaaaa", head: `${prefix}aaaaaaaa`, base: "main" });
    expect(writes[2]!.body?.body).toContain("- [test](https://example.test/job/9)");
    expect(writes[2]!.body?.body).not.toContain("lint");
    expect(event).toHaveBeenCalledWith("babysitter.main_repair.opened", expect.objectContaining({ repository, pull_request: 77, jobs: ["test"] }));
  });

  it("waits while the tip's runs are running and reports green once they pass", async () => {
    expect((await check({ runs: [run(1, "ci", tip, null)] })).outcome).toEqual({ state: "waiting", head: tip, reason: "ci-running" });
    expect((await check({ runs: [] })).outcome).toEqual({ state: "waiting", head: tip, reason: "no-ci-run" });
    const green = await check({ runs: [run(1, "ci", tip, "success"), run(2, "pkg.pr.new", tip, "success")] });
    expect(green.outcome).toEqual({ state: "green", head: tip });
    expect(green.writes).toEqual([]);
    expect(green.event).toHaveBeenCalledWith("babysitter.main_repair.green", { repository, head: tip });
  });

  it("falls back to the newest finished run of each workflow after the last merged repair", async () => {
    // The tip has no finished run, and the newest finished ci run on an older commit failed.
    const runs = [run(3, "ci", tip, null), run(2, "ci", older, "failure", "2026-11-13T10:00:00Z"), run(1, "ci", older, "success", "2026-11-13T09:00:00Z")];
    const opened = await check({ runs, closedPulls: [pull(5, `${prefix}cccccccc`, "2026-11-13T08:00:00Z")] });
    expect(opened.outcome).toMatchObject({ state: "opened", red: older, branch: `${prefix}bbbbbbbb` });
    // A repair that merged after that failure means the failure is already fixed.
    const repaired = await check({ runs, closedPulls: [pull(5, `${prefix}cccccccc`, "2026-11-13T10:30:00Z")] });
    expect(repaired.outcome).toEqual({ state: "waiting", head: tip, reason: "ci-running" });
    // A newer passing run clears the failure; a newer cancelled run does not.
    const passed = await check({ runs: [run(4, "ci", older, "success", "2026-11-13T10:30:00Z"), ...runs.slice(1)] });
    expect(passed.outcome).toEqual({ state: "waiting", head: tip, reason: "no-ci-run" });
    const cancelled = await check({ runs: [run(4, "ci", older, "cancelled", "2026-11-13T10:30:00Z"), ...runs.slice(1)] });
    expect(cancelled.outcome).toMatchObject({ state: "opened", red: older });
  });

  it("keeps one repair PR open at a time and never reopens a red commit's branch", async () => {
    const runs = [run(1, "ci", tip, "failure")];
    const open = await check({ runs, openPulls: [pull(9, "feature"), pull(10, `${prefix}11111111`)] });
    expect(open.outcome).toEqual({ state: "repair-open", head: tip, pullRequest: 10 });
    expect(open.writes).toEqual([]);
    // A fork's branch with the prefix is not a repair PR.
    const fork = await check({ runs, openPulls: [pull(11, `${prefix}11111111`, undefined, "someone/app")] });
    expect(fork.outcome).toMatchObject({ state: "opened" });
    const attempted = await check({ runs, branches: [`${prefix}aaaaaaaa`] });
    expect(attempted.outcome).toEqual({ state: "already-attempted", head: tip, red: tip, branch: `${prefix}aaaaaaaa` });
    expect(attempted.writes).toEqual([]);
  });

  it("force-cancels watched push runs with a stuck job", async () => {
    const state = {
      runs: [run(1, "ci", older, null), run(2, "pkg.pr.new", older, null), run(3, "docs", older, null), run(4, "ci", tip, "success"), run(5, "pkg.pr.new", tip, "success")],
      jobs: {
        1: [{ name: "test", status: "in_progress", conclusion: null, started_at: "2026-11-13T10:00:00Z" }],
        2: [{ name: "build", status: "in_progress", conclusion: null, started_at: "2026-11-13T11:30:00Z" }],
        3: [{ name: "docs", status: "in_progress", conclusion: null, started_at: "2026-11-13T08:00:00Z" }],
      },
    };
    const cancelled = await check(state);
    expect(cancelled.writes.map(write => write.path)).toEqual([`repos/${repository}/actions/runs/1/force-cancel`]);
    expect(cancelled.event).toHaveBeenCalledWith("babysitter.main_repair.cancelled_stuck", { repository, run: 1, head_sha: older, jobs: ["test"] });
    expect((await check(state, { stuckJobMinutes: 20 })).writes.map(write => write.path)).toEqual([`repos/${repository}/actions/runs/1/force-cancel`, `repos/${repository}/actions/runs/2/force-cancel`]);
    expect((await check(state, { stuckJobMinutes: false })).writes).toEqual([]);
  });

  it("recognizes a failed push run of a watched workflow on the default branch", () => {
    const delivery = (run: Record<string, unknown>, action = "completed") => ({
      action, repository: { full_name: repository, default_branch: "main" },
      workflow_run: { name: "ci", event: "push", head_branch: "main", conclusion: "failure", ...run },
    });
    expect(isFailedBaseRun("workflow_run", delivery({}), ["ci"])).toBe(true);
    expect(isFailedBaseRun("workflow_run", delivery({}, "requested"), ["ci"])).toBe(false);
    expect(isFailedBaseRun("workflow_run", delivery({ conclusion: "success" }), ["ci"])).toBe(false);
    expect(isFailedBaseRun("workflow_run", delivery({ head_branch: "fix" }), ["ci"])).toBe(false);
    expect(isFailedBaseRun("workflow_run", delivery({ event: "pull_request" }), ["ci"])).toBe(false);
    expect(isFailedBaseRun("workflow_run", delivery({ name: "docs" }), ["ci"])).toBe(false);
    expect(isFailedBaseRun("check_suite", delivery({}), ["ci"])).toBe(false);
  });
});

describe("Babysitter main repair in the runtime", () => {
  it("opens the repair PR from a reconcile, waits 10 minutes, and checks again after a failed run is delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-main-repair-"));
    try {
      let open = false;
      const { provider, calls } = await githubForge(request => {
        const path = request.path;
        if (path === `/repos/${repository}`) return { full_name: repository, default_branch: "main" };
        if (path === `/repos/${repository}/branches/main`) return { name: "main", commit: { sha: tip, commit: { tree: { sha: "t".repeat(40) } } } };
        if (path === `/repos/${repository}/actions/runs`) return { total_count: 1, workflow_runs: [run(1, "ci", tip, "failure")] };
        if (path === `/repos/${repository}/actions/runs/1/jobs`) return { total_count: 1, jobs: [{ name: "test", status: "completed", conclusion: "failure", started_at: "2026-11-13T11:00:00Z" }] };
        if (path === `/repos/${repository}/pulls` && request.method === "GET") return open && request.url.searchParams.get("state") === "open" ? [pull(77, `${prefix}aaaaaaaa`)] : [];
        if (path.startsWith(`/repos/${repository}/git/ref/heads/`)) return undefined;
        if (path === `/repos/${repository}/git/commits`) return { sha: "e".repeat(40) };
        if (path === `/repos/${repository}/git/refs`) return { ref: `refs/heads/${prefix}aaaaaaaa`, object: { sha: "e".repeat(40) } };
        if (path === `/repos/${repository}/pulls`) { open = true; return { number: 77 }; }
        return undefined;
      });
      const github = { identity: () => "repair-bot", forge: async () => provider } as unknown as GitHubHost;
      const agent = defineAgent({
        name: "babysitter",
        extends: babysitter,
        options: { filter: {}, merge: false, mainRepairBranchPrefix: prefix, mainRepair: { workflows: ["ci"], stuckJobMinutes: false } },
        driver: codexDriver({}),
      });
      const events = vi.fn();
      const errors = vi.fn();
      const runtime = createBabysitterRuntime({ agent, github, inboxPath: join(root, "inbox.sqlite"), repositories: [repository], concurrency: 1, activityAuthors: [], event: events, error: errors });
      const reconcile = async () => {
        const tracked: Promise<unknown>[] = [];
        await runtime.reconcile("test", { track: (work: Promise<unknown>) => { tracked.push(work) } } as Parameters<typeof runtime.reconcile>[1]);
        await Promise.all(tracked);
      };
      const writes = () => calls.filter(call => call.method === "POST" && call.path !== "/graphql").map(call => call.path);

      await reconcile();
      expect(writes()).toEqual([`/repos/${repository}/git/commits`, `/repos/${repository}/git/refs`, `/repos/${repository}/pulls`]);
      expect(events).toHaveBeenCalledWith("babysitter.main_repair.opened", expect.objectContaining({ repository, pull_request: 77 }));
      expect(errors.mock.calls.filter(([name]) => String(name).startsWith("babysitter.main_repair"))).toEqual([]);

      const before = calls.length;
      await reconcile();
      expect(calls.slice(before).some(call => call.path === `/repos/${repository}/branches/main`)).toBe(false);

      const failedRun = { action: "completed", repository: { full_name: repository, default_branch: "main" }, workflow_run: { name: "ci", event: "push", head_branch: "main", conclusion: "failure" } };
      expect(await runtime.observeMainRepair("workflow_run", { ...failedRun, repository: { full_name: "acme/other", default_branch: "main" } })).toBe(false);
      expect(await runtime.observeMainRepair("workflow_run", failedRun)).toBe(true);
      await reconcile();
      expect(events).toHaveBeenCalledWith("babysitter.main_repair.repair_open", expect.objectContaining({ repository, pull_request: 77 }));
      expect(writes()).toHaveLength(3);
      await runtime.inbox.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
