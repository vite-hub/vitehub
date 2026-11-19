import { expect, it, vi } from "vitest";
import { codexDriver, defineAgent } from "@vite-hub/agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { babysitter } from "../src/babysitter.ts";
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
    expect(events).toHaveBeenCalledWith("babysitter.reconcile.stalled", expect.objectContaining({
      reason: "test", step: "bootstrap", subject: repository, active_owners: [], ready: 0,
    }));

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

it("rejects a stall bound that a timer cannot hold", () => {
  const agent = defineAgent({ name: "babysitter", extends: babysitter, options: { filter: {}, merge: false }, driver: codexDriver({}) });
  const github = { identity: () => "repair-bot", forge: async () => { throw new Error("unused"); } } as unknown as GitHubHost;
  expect(() => createBabysitterRuntime({ agent, github, inboxPath: ":memory:", repositories: [repository], concurrency: 1, activityAuthors: [], stallMs: 0 }))
    .toThrow(expect.objectContaining({ code: "PRESETS_BABYSITTER_OPTION_INVALID" }));
});
