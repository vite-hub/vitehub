import { expect, it, vi } from "vitest";
import { codexDriver, defineAgent } from "@vite-hub/agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { babysitter } from "../src/babysitter.ts";
import { createBabysitterAdmission } from "../src/babysitter/admission.ts";
import { probeChangedSnapshots } from "../src/babysitter/inbox/snapshot-sync.ts";
import { createBabysitterRuntime } from "../src/babysitter/server.ts";
import type { GitHubHost } from "../src/github/index.ts";
import { githubForge } from "./fixtures/github-forge.ts";

const repository = "acme/app";

it("stops a reconcile whose GitHub read never answers, names the step, and lets the next reconcile run", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-reconcile-stall-"));
  try {
    let hang = true;
    let answerHungRead!: (value: unknown) => void;
    const { provider, calls } = await githubForge(request => {
      if (request.path === `/repos/${repository}/pulls` && request.method === "GET") {
        if (hang) {
          hang = false;
          return new Promise(resolve => { answerHungRead = resolve; });
        }
        return [];
      }
      return undefined;
    });
    const github = { identity: () => "repair-bot", forge: async () => provider } as unknown as GitHubHost;
    const agent = defineAgent({ name: "babysitter", extends: babysitter, options: { filter: {}, merge: false }, driver: codexDriver({}) });
    const events = vi.fn();
    const runtime = createBabysitterRuntime({
      agent, github, inboxPath: join(root, "inbox.sqlite"), repositories: [repository], concurrency: 1, activityAuthors: [], event: events, stallMs: 200,
    });
    const reconcile = () => runtime.reconcile("test", { track: async work => await work });

    // Without the stall bound this await never settles, and the process host never starts another reconcile.
    await expect(reconcile()).rejects.toMatchObject({ code: "PRESETS_BABYSITTER_RECONCILE_STALLED" });
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith("babysitter.reconcile.stalled", expect.objectContaining({
      reason: "test", step: "bootstrap", subject: repository, active_owners: [], ready: 0,
    })));

    // The next reconcile gets past the stuck step and reads the open pull requests again.
    const stalledCalls = calls.length;
    await reconcile();
    expect(calls.slice(stalledCalls).some(call => call.path === "/graphql")).toBe(true);

    // The stopped reconcile ends at its next step when its read finally answers, so it claims nothing.
    const before = calls.length;
    answerHungRead([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls.length).toBe(before);
    await runtime.inbox.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function testRuntime(options: Partial<Parameters<typeof createBabysitterRuntime>[0]> = {}) {
  const { provider } = await githubForge(() => []);
  const github = { identity: () => "repair-bot", forge: async () => provider } as unknown as GitHubHost;
  const agent = defineAgent({ name: "babysitter", extends: babysitter, options: { filter: {}, merge: false }, driver: codexDriver({}) });
  return createBabysitterRuntime({
    agent, github, inboxPath: ":memory:", repositories: [repository], concurrency: 1, activityAuthors: [], stallMs: 200, ...options,
  });
}

it("takes a fresh built-in admission sample after a stall", async () => {
  const first = Promise.withResolvers<{ reason: string }>();
  const check = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(undefined);
  const admission = createBabysitterAdmission({ limits: { paused: false }, check });
  const runtime = await testRuntime({ admission: signal => admission(undefined, signal) });
  try {
    const reconcile = () => runtime.reconcile("test", { track: async work => await work });
    await expect(reconcile()).rejects.toMatchObject({ code: "PRESETS_BABYSITTER_RECONCILE_STALLED" });
    expect(check).toHaveBeenCalledTimes(1);
    await reconcile();
    expect(check).toHaveBeenCalledTimes(2);
    first.resolve({ reason: "old sample" });
    await first.promise;
    expect(await admission.health()).toMatchObject({ accepting: true });
  } finally {
    await runtime.inbox.close();
  }
});

it("rejects without waiting for telemetry and contains a throwing event handler", async () => {
  const summary = Promise.withResolvers<[]>();
  const event = vi.fn((name: string) => {
    if (name === "babysitter.reconcile.stalled") throw new Error("event failed");
  });
  const runtime = await testRuntime({ admission: () => new Promise(() => {}), event });
  const spy = vi.spyOn(runtime.inbox, "summary").mockReturnValue(summary.promise);
  try {
    await expect(runtime.reconcile("test", { track: async work => await work })).rejects.toMatchObject({ code: "PRESETS_BABYSITTER_RECONCILE_STALLED" });
    expect(spy).toHaveBeenCalledOnce();
    expect(event).not.toHaveBeenCalledWith("babysitter.reconcile.stalled", expect.anything());
    summary.resolve([]);
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith("babysitter.reconcile.stalled", expect.objectContaining({ step: "admission" })));
  } finally {
    spy.mockRestore();
    await runtime.inbox.close();
  }
});

it("keeps a replacement snapshot retry when a stopped probe gets its old response", async () => {
  const { inbox } = await testRuntime();
  try {
    const key = `snapshot-changed:${repository}:1`;
    await inbox.seed(repository, { number: 1, state: "open", head: { sha: "head" } });
    await inbox.setMeta(key, { fingerprint: "old", retryAt: 0 });
    const response = Promise.withResolvers<unknown[]>();
    const read = vi.fn(() => response.promise);
    const controller = new AbortController();
    const probing = probeChangedSnapshots(inbox, read, Date.now(), undefined, [], undefined, undefined, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    controller.abort();
    const retry = { fingerprint: "new", retryAt: Date.now() + 120_000 };
    await inbox.setMeta(key, retry);
    response.resolve([{ number: 1, state: "closed", head: { sha: "head" } }]);
    await expect(probing).rejects.toMatchObject({ name: "AbortError" });
    expect(await inbox.meta(key)).toEqual(retry);
    expect(await inbox.meta(`change-fingerprint:${repository}:1`)).toBeUndefined();
    expect((await inbox.get(repository, 1))?.pr?.state).toBe("open");
  } finally {
    await inbox.close();
  }
});

it("rejects a stall bound that a timer cannot hold", () => {
  const agent = defineAgent({ name: "babysitter", extends: babysitter, options: { filter: {}, merge: false }, driver: codexDriver({}) });
  const github = { identity: () => "repair-bot", forge: async () => { throw new Error("unused"); } } as unknown as GitHubHost;
  expect(() => createBabysitterRuntime({ agent, github, inboxPath: ":memory:", repositories: [repository], concurrency: 1, activityAuthors: [], stallMs: 0 }))
    .toThrow(expect.objectContaining({ code: "PRESETS_BABYSITTER_OPTION_INVALID" }));
});
