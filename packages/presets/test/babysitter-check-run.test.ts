import { describe, expect, it, type TestContext } from "vitest";
import { defineAgent } from "@vite-hub/agent";
import { babysitter } from "../src/babysitter.ts";
import { PullRequestInbox, looksMergeReady, type Snapshot } from "../src/babysitter/inbox/store.ts";
import { readSnapshot } from "../src/babysitter/inbox/snapshot-sync.ts";
import { checksStillRunning, failureKeys } from "../src/babysitter/wait.ts";
import { directMergeReadiness, snapshotCheckEvidence } from "../src/babysitter/merge.ts";
import { babysitterCheckRunBody, createBabysitterCheckRuns } from "../src/babysitter/check-run.ts";
import type { StatusDelivery } from "../src/babysitter/inbox/status-delivery.ts";

const repository = "acme/app";
const head = "a".repeat(40);
const pr = { number: 7, state: "open", draft: false, user: { login: "dev" }, head: { sha: head, ref: "fix" }, base: { sha: "b".repeat(40), ref: "main" }, updated_at: "2026-11-12T00:00:00Z" };
const own = (status: string, conclusion: string | null = null) => ({ id: 90, name: "babysitter", head_sha: head, status, conclusion, app: { id: 3 }, started_at: new Date().toISOString() });
const lint = { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "success", app: { id: 5 } };

function memory(t: TestContext) {
  const inbox = new PullRequestInbox({ path: ":memory:", repositories: [repository], activityAuthors: ["worker[bot]"], activityAppId: 3 });
  t.onTestFinished(() => inbox.close());
  return inbox;
}

async function snapshot(t: TestContext, ownCheck: ReturnType<typeof own>): Promise<Snapshot> {
  const inbox = memory(t);
  await inbox.seed(repository, pr);
  const value = structuredClone((await inbox.claim(1))[0]!.snapshot);
  value.threadsHydrated = true;
  value.checks = { "check_run:1": lint, "check_run:90": ownCheck };
  return value;
}

describe("the Babysitter's own check run", () => {
  it("is not a running check, a failure or merge evidence", async t => {
    const running = await snapshot(t, own("in_progress"));
    expect(checksStillRunning(running)).toBe(false);
    expect(looksMergeReady(running)).toBe(true);
    const failed = await snapshot(t, own("completed", "failure"));
    expect(failureKeys(failed)).toEqual([]);
    expect(snapshotCheckEvidence(failed).checkRuns.map(check => check.name)).toEqual(["lint"]);
    expect(directMergeReadiness(failed, "passed")).toEqual({ ready: true, head });
  });

  it("does not wake the PR or enter its snapshot through webhooks", async t => {
    const inbox = memory(t);
    await inbox.seed(repository, pr);
    const before = (await inbox.get(repository, 7))!.generation;
    const result = await inbox.ingest("own", "check_run", { action: "completed", repository: { full_name: repository }, check_run: { ...own("completed", "success"), pull_requests: [{ number: 7 }] } });
    expect(result).toMatchObject({ ignored: true, reason: "own check run", queued: [], updated: [] });
    const suite = await inbox.ingest("suite", "check_suite", { action: "completed", repository: { full_name: repository }, check_suite: { id: 4, head_sha: head, app: { id: 3 }, conclusion: "success", pull_requests: [{ number: 7 }] } });
    expect(suite).toMatchObject({ ignored: true, reason: "own check suite" });
    const current = (await inbox.get(repository, 7))!;
    expect(current.generation).toBe(before);
    expect(current.checks).toEqual({});
  });

  it("is left out of REST snapshots", async () => {
    const read = async (path: string) => {
      if (path.endsWith("/pulls/7")) return [pr];
      if (path.includes("/check-runs")) return [lint, own("in_progress")];
      return [];
    };
    const result = await readSnapshot(read, repository, 7);
    expect(Object.values(result.checks ?? {}).map(check => check.name)).toEqual(["lint"]);
  });
});

const delivery = (status: StatusDelivery["activity"]["status"], summary = "Waiting on CI for the new head.\nMore detail."): StatusDelivery => ({
  version: "v", contentKey: "k", repository, number: 7, head, generation: 1, text: summary, attempts: 0, nextAt: 0,
  activity: { runId: "r", status, startedAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:05:00Z", links: [{ label: "Console", url: "https://console.example/s/1" }], tasks: [], summary },
});

function provider(fail?: (method: string) => unknown) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let nextId = 500;
  return {
    calls,
    async request<T>(method: string, path: string, options: { body?: unknown } = {}): Promise<{ data: T }> {
      calls.push({ method, path, body: options.body as Record<string, unknown> | undefined });
      const failure = fail?.(method);
      if (failure) throw failure;
      // SAFETY: the publisher reads only `check_runs` and `id` from these responses.
      if (method === "GET") return { data: { check_runs: [] } as T };
      return { data: { id: method === "POST" ? nextId++ : Number(path.split("/").pop()) } as T };
    },
  };
}

describe("babysitter check run publication", () => {
  it("maps each outbox state to a check run", () => {
    expect(babysitterCheckRunBody(delivery("queued").activity)).toMatchObject({ status: "queued", output: { title: "Queued: Waiting on CI for the new head." } });
    expect(babysitterCheckRunBody(delivery("running").activity)).toMatchObject({ status: "in_progress", started_at: "2026-11-12T00:00:00Z" });
    expect(babysitterCheckRunBody(delivery("waiting").activity)).toEqual({
      status: "completed", conclusion: "neutral", completed_at: "2026-11-12T00:05:00Z", started_at: "2026-11-12T00:00:00Z",
      details_url: "https://console.example/s/1",
      output: { title: "Waiting: Waiting on CI for the new head.", summary: "Waiting on CI for the new head.\nMore detail." },
    });
    expect(babysitterCheckRunBody(delivery("completed").activity)).toMatchObject({ status: "completed", conclusion: "success" });
    expect(babysitterCheckRunBody(delivery("failed").activity)).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("updates one run per head and starts a new run after it completed", async () => {
    const forge = provider();
    const runs = createBabysitterCheckRuns({ forge: async () => forge });
    const signal = new AbortController().signal;
    await runs.publish(delivery("queued"), signal);
    await runs.publish(delivery("running"), signal);
    await runs.publish(delivery("completed"), signal);
    await runs.publish(delivery("running"), signal);
    expect(forge.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      `GET /repos/${repository}/commits/${head}/check-runs`,
      `POST /repos/${repository}/check-runs`,
      `PATCH /repos/${repository}/check-runs/500`,
      `PATCH /repos/${repository}/check-runs/500`,
      `POST /repos/${repository}/check-runs`,
    ]);
    expect(forge.calls[1]!.body).toMatchObject({ name: "babysitter", head_sha: head, status: "queued" });
  });

  it("reports a missing checks permission once and stops writing to that repository", async () => {
    const forbidden = Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    const forge = provider(method => method === "POST" ? forbidden : undefined);
    const errors: unknown[] = [];
    const runs = createBabysitterCheckRuns({ forge: async () => forge, error: (name, _error, properties) => errors.push({ name, ...properties }) });
    const signal = new AbortController().signal;
    await runs.publish(delivery("queued"), signal);
    await runs.publish(delivery("running"), signal);
    expect(forge.calls).toHaveLength(2);
    expect(errors).toEqual([{ name: "babysitter.status.check_run.forbidden", repository, permission: "checks: write" }]);
  });

  it("throws other failures so the outbox retries them", async () => {
    const outage = Object.assign(new Error("Server error"), { status: 502 });
    const runs = createBabysitterCheckRuns({ forge: async () => provider(method => method === "POST" ? outage : undefined) });
    await expect(runs.publish(delivery("queued"), new AbortController().signal)).rejects.toBe(outage);
  });
});

describe("babysitter status option", () => {
  it("accepts booleans and rejects anything else", () => {
    expect(() => defineAgent({ extends: babysitter, options: { status: { comment: false, checkRun: true } } })).not.toThrow();
    expect(() => defineAgent({ extends: babysitter, options: { status: { checkRun: "yes" as unknown as boolean } } })).toThrow(/status must be an object/);
  });
});
