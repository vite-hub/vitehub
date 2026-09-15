import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const createProviderRuntime = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime }));
vi.mock("../src/internal/provider-runtime-packages.ts", () => ({
  resolveInstalledProviderExecutable: () => "/bin/true",
}));

import { agentWithColocatedInstructions, defineAgent } from "../src/index.ts";
import { babysitter } from "../src/presets/babysitter.ts";
import { createBabysitterRuntime } from "../src/presets/babysitter/server.ts";
import type { GitHubHost } from "../src/server/github.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(autoMerge = false) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-babysitter-preset-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, "source.ts"), "export const value = 1\n");
  let head = "a".repeat(40);
  let pushed = false;
  let checkoutFailure: Error | undefined;
  const checkoutController = new AbortController();
  let abortOperation = false;
  let onAdmission: (() => void) | undefined;
  const pr = () => ({
    number: 12,
    state: "open",
    draft: false,
    title: "Fix value",
    body: "Repair the exported value.",
    user: { login: "developer" },
    labels: [{ name: "repair" }],
    head: { sha: head, ref: "fix", repo: { full_name: "acme/app" } },
    base: { sha: "c".repeat(40), ref: "main", repo: { full_name: "acme/app" } },
    html_url: "https://github.com/acme/app/pull/12",
  });
  const pageInfo = { hasNextPage: false, endCursor: null };
  const graphSnapshot = () => ({
    repository: {
      autoMergeAllowed: true,
      squashMergeAllowed: true,
      mergeCommitAllowed: true,
      rebaseMergeAllowed: true,
      deleteBranchOnMerge: false,
      pullRequest: {
        id: "PR_12",
        number: 12,
        state: "OPEN",
        isDraft: false,
        headRefOid: head,
        headRefName: "fix",
        baseRefName: "main",
        title: "Fix value",
        body: "Repair the exported value.",
        author: { login: "developer", __typename: "User" },
        authorAssociation: "MEMBER",
        isCrossRepository: false,
        headRepository: { nameWithOwner: "acme/app" },
        labels: { nodes: [{ name: "repair" }], pageInfo },
        reviewDecision: "APPROVED",
        autoMergeRequest: null,
        latestOpinionatedReviews: { nodes: [], pageInfo },
      },
    },
  });
  const command = vi.fn<GitHubHost["command"]>(async (args, request) => {
    const text = args.join(" ");
    if (text.includes("enablePullRequestAutoMerge"))
      return {
        stdout: JSON.stringify({
          data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_12", state: "OPEN", headRefOid: head, autoMergeRequest: { enabledAt: "2026-09-13T00:00:00Z" } } } },
        }),
        stderr: "",
      };
    if (args.includes("graphql")) {
      if (abortOperation && !text.includes("reviewThreads")) {
        checkoutController.abort(new DOMException("Checkout cancelled", "AbortError"));
        request?.signal?.throwIfAborted();
      }
      const data = text.includes("reviewThreads")
        ? { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo } } } }
        : graphSnapshot();
      if (!text.includes("reviewThreads")) onAdmission?.();
      return { stdout: JSON.stringify({ data }), stderr: "" };
    }
    if (text.includes("/rules/branches/"))
      return {
        stdout: JSON.stringify([
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "test" }] },
          },
        ]),
        stderr: "",
      };
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const data =
      path.includes("pulls?state") || path === "repos/acme/app/pulls/12"
        ? [pr()]
        : path.includes("/reviews?")
          ? [
              {
                id: 41,
                body: "Fix value",
                user: { login: "new-review-bot[bot]", type: "Bot" },
                state: "COMMENTED",
                commit_id: head,
              },
            ]
          : path.includes("check-runs")
            ? [
                {
                  id: 1,
                  name: "test",
                  head_sha: head,
                  status: pushed ? "in_progress" : "completed",
                  conclusion: pushed ? null : "success",
                },
              ]
            : [];
    return { stdout: data.map((value) => JSON.stringify(value)).join("\n"), stderr: "" };
  });
  let workerDirectory: string | undefined;
  const prepare = vi.fn(async (directory: string) => { workerDirectory = directory });
  const push = vi.fn(async (_target?: string, _options?: { signal?: AbortSignal, beforePush?: () => void }) => {
    pushed = true;
    head = "b".repeat(40);
    return head;
  });
  const github: GitHubHost = {
    command,
    channel: () => ({ kind: "github" }),
    environment: async () => {
      throw new Error("Worker must not resolve GitHub credentials");
    },
    access: async () => {
      throw new Error("Not used");
    },
    budget: () => ({ limited: false }),
    ensureGraphQLBudget: async () => ({
      checkedAt: Date.now(),
      remaining: 100,
      resetAt: Date.now() + 60_000,
      release() {},
      settle() {},
      submit() {},
    }),
    isRateLimitError: (error) => error instanceof Error && error.message === "rate limited",
    withPullRequestCheckout: async (_pr, run) => {
      const result = await run({
        path: checkout,
        prepareWorkspace: prepare,
        push,
        signal: checkoutController.signal,
        env: { GIT_AUTHOR_NAME: "Repair bot", GIT_AUTHOR_EMAIL: "repair@example.test", GIT_COMMITTER_NAME: "Repair bot", GIT_COMMITTER_EMAIL: "repair@example.test", GH_TOKEN: "host-secret" },
        token: "host-secret",
      } as Parameters<Parameters<GitHubHost["withPullRequestCheckout"]>[1]>[0]);
      if (checkoutFailure) throw checkoutFailure;
      return result;
    },
  };
  const errors = vi.fn();
  const agent = agentWithColocatedInstructions(defineAgent({
    preset: "babysitter",
    presets: { babysitter },
    options: { filter: { labels: { allow: ["repair"] } }, autoMerge },
    driver: { env: { GH_TOKEN: "must-not-leak", OPENAI_API_KEY: "provider-only" } },
  }), "Preserve the documented API contract.");
  const runtime = createBabysitterRuntime({
    agent,
    github,
    inboxPath: join(root, "inbox.sqlite"),
    repositories: ["acme/app"],
    concurrency: 1,
    error: errors,
  });
  const passes: Array<{ tools: string[]; prompt: string; session: string; instructions: string }> = [];
  let operation: "pushRepair" | "requestAutoMerge" | "updatePullRequest" | undefined;
  let operationArguments: Record<string, unknown> = {};
  createProviderRuntime.mockImplementation(async () => {
    let threadId = `pass-${passes.length}`;
    let finishTurn!: () => void;
    const turnSent = new Promise<void>(resolve => { finishTurn = resolve });
    let mcp: { endpoint: string; authorizationHeader: string } | undefined;
    return {
      attachmentsDirectory: join(root, "attachments"),
      close: async () => {},
      stopSession: async () => {},
      interruptTurn: async () => {},
      startSession: async (input: { mcp?: typeof mcp, threadId: string }) => {
        mcp = input.mcp;
        threadId = input.threadId;
        return { threadId };
      },
      sendTurn: async (input: { input: string }) => {
        if (!mcp) throw new Error("Missing repair tools");
        const client = new Client({ name: "babysitter-test", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(mcp.endpoint), {
            requestInit: { headers: { Authorization: mcp.authorizationHeader } },
          }),
        );
        try {
          passes.push({
            tools: (await client.listTools()).tools.map((tool) => tool.name),
            prompt: input.input,
            session: threadId,
            instructions: await readFile(join(workerDirectory!, "AGENTS.md"), "utf8"),
          });
          if (operation) {
            const result = await client.callTool({ name: operation, arguments: operationArguments });
            if (onAdmission) expect(result.isError, JSON.stringify(result)).toBe(true);
            else if (!checkoutController.signal.aborted) expect(result.isError, JSON.stringify(result)).not.toBe(true);
          }
        } finally {
          await client.close();
        }
        finishTurn();
        return { threadId, turnId: "turn-1" };
      },
      events: {
        async *[Symbol.asyncIterator]() {
          await turnSent;
          yield {
            type: "content.delta",
            threadId,
            turnId: "turn-1",
            payload: {
              delta: JSON.stringify({
                disposition: "park",
                text: "Repair checked. Waiting for checks.",
              }),
              streamKind: "assistant_text",
            },
          };
          yield {
            type: "turn.completed",
            threadId,
            turnId: "turn-1",
            payload: { state: "completed", stopReason: "end_turn" },
          };
        },
      },
    };
  });
  async function reconcile() {
    const tracked: Promise<unknown>[] = [];
    await runtime.reconcile("test", {
      track: (value) => {
        tracked.push(value);
      },
    } as Parameters<typeof runtime.reconcile>[1]);
    await Promise.all(tracked);
    if (!checkoutFailure || checkoutFailure.name === "AbortError" || checkoutFailure.message === "rate limited")
      expect(errors.mock.calls).toEqual([]);
    else expect(errors).toHaveBeenCalledOnce();
  }
  return {
    runtime,
    reconcile,
    passes,
    push,
    prepare,
    command,
    choose: (value: typeof operation, args: Record<string, unknown> = {}) => {
      operation = value;
      operationArguments = args;
    },
    pr,
    failCheckout: (error: Error) => { checkoutFailure = error },
    abortOnOperation: () => { abortOperation = true },
    onAdmission: (callback: () => void) => { onAdmission = callback },
  };
}

describe("Babysitter preset runtime", () => {
  it("allows the metadata tool to clear the pull request body", async () => {
    const f = await fixture();
    f.choose("updatePullRequest", { body: "" });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH") && args.includes("body="))).toBe(true);
    } finally { f.runtime.inbox.close(); }
  });

  it.each(["reclaimed", "expired"])("fences an admitted push when its lease is %s", async (loss) => {
    const f = await fixture();
    f.choose("pushRepair");
    f.onAdmission(() => {});
    let rejected = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      const current = f.runtime.inbox.get("acme/app", 12)!;
      if (loss === "reclaimed") {
        f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
        f.runtime.inbox.claim(1);
      } else {
        vi.spyOn(Date, "now").mockReturnValue(current.leaseUntil);
      }
      try { options?.beforePush?.(); }
      catch (error) { rejected = true; throw error; }
      return "b".repeat(40);
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      expect(rejected).toBe(true);
    } finally { vi.restoreAllMocks(); f.runtime.inbox.close(); }
  });

  it("aborts an in-flight push when another owner reclaims the lease", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    let aborted = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      if (!options?.signal) throw new Error("Missing push cancellation signal");
      const current = f.runtime.inbox.get("acme/app", 12)!;
      f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
      f.runtime.inbox.claim(1);
      return await new Promise<string>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal!.reason);
        }, { once: true });
      });
    });
    try {
      await f.reconcile();
      expect(aborted).toBe(true);
    } finally { f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s when another owner reclaims during admission", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    let replacementToken: string | undefined;
    f.onAdmission(() => {
      if (replacementToken) return;
      const current = f.runtime.inbox.get("acme/app", 12)!;
      f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
      replacementToken = f.runtime.inbox.claim(1)[0]!.token;
    });
    try {
      await f.reconcile();
      expect(replacementToken).toBeDefined();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
      expect(f.runtime.inbox.get("acme/app", 12)?.lease).toBe(replacementToken);
    } finally { f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s when feedback advances the claimed generation during admission", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    let generation: number | undefined;
    f.onAdmission(() => {
      if (generation !== undefined) return;
      const current = f.runtime.inbox.get("acme/app", 12)!;
      generation = current.generation;
      f.runtime.inbox.ingest("new-inline-feedback", "pull_request_review_comment", {
        repository: { full_name: "acme/app" },
        action: "created",
        pull_request: f.pr(),
        comment: { id: 99, body: "Fix this regression before merging.", user: { login: "reviewer", type: "User" } },
      });
      const updated = f.runtime.inbox.get("acme/app", 12)!;
      expect(updated.generation).toBeGreaterThan(generation);
      expect(updated.lease).toBe(current.lease);
    });
    try {
      await f.reconcile();
      expect(generation).toBeDefined();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
      const current = f.runtime.inbox.get("acme/app", 12)!;
      expect(current.handled).toBeLessThan(current.generation);
      expect(current.status).toBe("ready");
    } finally { f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s after lease expiry without waiting for recovery", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    f.onAdmission(() => {
      const current = f.runtime.inbox.get("acme/app", 12)!;
      vi.spyOn(Date, "now").mockReturnValue(current.leaseUntil);
    });
    try {
      await f.reconcile();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      f.runtime.inbox.close();
    }
  });

  it.each([
    new DOMException("Checkout cancelled", "AbortError"),
    new Error("rate limited"),
    new Error("Checkout cleanup failed"),
  ])("parks a successful push after checkout failure: %s", async (error) => {
    const f = await fixture();
    f.choose("pushRepair");
    f.failCheckout(error);
    await f.reconcile();
    expect(f.push).toHaveBeenCalledOnce();
    const state = f.runtime.inbox.get("acme/app", 12)!;
    expect(state.status).toBe("waiting");
    expect(state.handled).toBe(state.generation);
    expect(state.attempts).toBe(0);
    f.runtime.inbox.ingest("head-pushed", "pull_request", {
      repository: { full_name: "acme/app" },
      action: "synchronize",
      pull_request: f.pr(),
    });
    expect(f.runtime.inbox.get("acme/app", 12)?.status).toBe("ready");
  });

  it("retries checkout failure when no repair was pushed", async () => {
    const f = await fixture();
    f.failCheckout(new Error("Checkout cleanup failed"));
    await f.reconcile();
    expect(f.push).not.toHaveBeenCalled();
    const state = f.runtime.inbox.get("acme/app", 12)!;
    expect(state.status).toBe("ready");
    expect(state.handled).toBeLessThan(state.generation);
    expect(state.attempts).toBe(1);
  });

  it("repairs through broker tools, parks without polling, and resumes on new evidence with merge disabled", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    await f.reconcile();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.passes[0]?.tools).not.toContain("requestAutoMerge");
    expect(f.passes[0]?.prompt).toContain("new-review-bot[bot]");
    expect(f.passes[0]?.instructions).toContain("Preserve the documented API contract.");
    expect(f.passes[0]?.instructions).not.toContain("{{{ instructions }}}");
    const environment = createProviderRuntime.mock.calls[0]?.[0].environment;
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).toHaveProperty("OPENAI_API_KEY", "provider-only");
    const commitRoot = await mkdtemp(join(tmpdir(), "vitehub-babysitter-commit-"));
    roots.push(commitRoot);
    const git = promisify(execFile);
    const execution = { cwd: commitRoot, env: environment };
    await git("git", ["init", "--quiet"], execution);
    await writeFile(join(commitRoot, "repair.txt"), "verified repair");
    await git("git", ["add", "repair.txt"], execution);
    await git("git", ["commit", "--quiet", "-m", "Repair"], execution);
    const author = await git("git", ["log", "-1", "--format=%an <%ae>"], execution);
    expect(author.stdout.trim()).toBe("Repair bot <repair@example.test>");
    const requests = f.command.mock.calls.length;
    await f.reconcile();
    expect(f.passes).toHaveLength(1);
    expect(f.command).toHaveBeenCalledTimes(requests);
    f.choose(undefined);
    f.runtime.inbox.ingest("head-pushed", "pull_request", {
      repository: { full_name: "acme/app" },
      action: "synchronize",
      pull_request: f.pr(),
    });
    await f.reconcile();
    expect(f.passes).toHaveLength(2);
    f.runtime.inbox.ingest("new-feedback", "pull_request_review", {
      repository: { full_name: "acme/app" }, action: "submitted", pull_request: f.pr(),
      review: { id: 42, body: "Check this follow-up", user: { login: "another-bot[bot]", type: "Bot" }, state: "COMMENTED", commit_id: f.pr().head.sha },
    });
    await f.reconcile();
    expect(f.passes).toHaveLength(3);
    expect(new Set(f.passes.map(pass => pass.session)).size).toBe(3);
    expect(f.runtime.workload()).toEqual({ running: 0 });
    f.runtime.inbox.close();
  });

  it("cancels host operations when the checkout is revoked", async () => {
    const f = await fixture(true);
    f.choose("requestAutoMerge");
    f.abortOnOperation();
    await f.reconcile();
    expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    expect(f.runtime.workload()).toEqual({ running: 0 });
    f.runtime.inbox.close();
  });

  it("enables native auto-merge only through the configured host operation", async () => {
    const f = await fixture(true);
    f.choose("requestAutoMerge");
    await f.reconcile();
    expect(f.passes[0]?.tools).toContain("requestAutoMerge");
    expect(
      f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge")),
    ).toBe(true);
    expect(f.command.mock.calls.some(([args]) => args.includes("merge"))).toBe(false);
    f.runtime.inbox.close();
  });
});
