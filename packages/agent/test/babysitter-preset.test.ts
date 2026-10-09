import * as buildRevisions from "../src/internal/build-revision.ts";
import { createCheckWait } from "../src/presets/babysitter/wait.ts";
import { babysitterBudgetWindows, resolveBabysitterAdmissionLimits, type BabysitterAdmissionResult } from "../src/presets/babysitter/admission.ts";
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

vi.mock("../src/server/github-repair.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/server/github-repair.ts")>(),
  prepareGitHubRepairBase: vi.fn(async () => {}),
}));
const boxDefinitions = vi.hoisted(() => vi.fn());
const remoteBoxes = vi.hoisted(() => new Map<string, { path: string; closed: boolean }>());
vi.mock("@vite-hub/box", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/box")>();
  const resolveBox: typeof actual.resolveBox = async (definition, context, options) => {
    boxDefinitions(definition);
    const box = await actual.resolveBox(definition, context, options);
    const remote = remoteBoxes.get(box.plan.workspace.path ?? "");
    if (!remote) return box;
    const copied = await actual.resolveBox({ ...definition, cwd: remote.path }, context, options);
    return { plan: { ...copied.plan, runtime: "crabbox" }, async open(openOptions) {
      const session = await copied.open(openOptions);
      return { ...session, async close() { remote.closed = true; await session.close(); } };
    } };
  };
  return { ...actual, resolveBox };
});

import { agentWithColocatedInstructions, defineAgent, defineCapability, getAgentFromRegistry } from "../src/index.ts";
import { babysitter } from "../src/presets/babysitter.ts";
import { babysitterInstructions } from "../src/presets/babysitter/instructions.ts";
import { boundedMergeReady } from "../src/presets/babysitter/merge-ready.ts";
import { createBabysitterRuntime } from "../src/presets/babysitter/server.ts";
import { getAgentLayerOptions } from "../src/agent-layers.ts";
import { github as githubChannel, githubChannelIdentity } from "../src/channels.ts";
import { feedbackFingerprints, liveMergeReadiness } from "../src/presets/babysitter/merge.ts";
import * as githubRuns from "../src/server/github-pull-requests.ts";
import { commitGitHubPullRequestWorkspace, prepareGitHubRepairBase } from "../src/server/github-repair.ts";
import * as githubInstalls from "../src/server/github-install.ts";
import { agentInvocationId } from "../src/invocations.ts";
import type { GitHubHost } from "../src/server/github.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  remoteBoxes.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(autoMerge = false, discovered = false, preset: { resolveAfterPush?: string; operationInputs?: Record<string, unknown>[]; expectedOperationErrorAt?: number; operationCount?: number; inboxPath?: string; activityBarrier?: Promise<void>; allowOperationAfterAdmission?: boolean; remoteBox?: boolean; boxCheckout?: boolean; box?: boolean; actionsDenied?: boolean; admission?: () => Promise<Pick<BabysitterAdmissionResult, "accepting" | "hostOnly" | "reason" | "retryAt" | "detail">>; agentName?: string; result?: Record<string, unknown>; merge?: unknown; driver?: string; mergeableState?: string; baseBranchHead?: string; base?: string; parents?: unknown[]; postPushGraceMs?: number; providerRetryDelayMs?: number; mentionAllowlist?: string[]; options?: Record<string, unknown>; driverEnv?: Record<string, string>; gitWorkspace?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-babysitter-preset-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, "source.ts"), "export const value = 1\n");
  let head = "a".repeat(40);
  let baseHead = "c".repeat(40);
  const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args])).stdout.trim();
  let remoteBox: { path: string; closed: boolean } | undefined;
  if (preset.remoteBox) {
    await git(checkout, "init");
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-m", "base");
    head = await git(checkout, "rev-parse", "HEAD");
    remoteBox = { path: join(root, "remote"), closed: false };
    await git(root, "clone", checkout, remoteBox.path);
    remoteBoxes.set(checkout, remoteBox);
  }
  let pushed = false;
  let checkoutFailure: Error | undefined;
  const checkoutController = new AbortController();
  let abortOperation = false;
  let onAdmission: (() => void | Promise<void>) | undefined;
  let onRepair: (() => void | Promise<void>) | undefined;
  let openPullRequests = true;
  // Check runs that the REST API reports in addition to the fixture's required "test" run.
  const extraCheckRuns: Record<string, unknown>[] = [];
  const pr = () => ({
    number: 12,
    state: "open",
    draft: false,
    title: "Fix value",
    body: "Repair the exported value.",
    user: { login: "developer" },
    labels: [{ name: "repair" }],
    head: { sha: head, ref: "fix", repo: { full_name: "acme/app" } },
    base: { sha: baseHead, ref: preset.base ?? "main", repo: { full_name: "acme/app", default_branch: "main", owner: { login: "acme" } } },
    html_url: "https://github.com/acme/app/pull/12",
    mergeable_state: preset.mergeableState ?? "clean",
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
        baseRefOid: baseHead,
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
    if (preset.actionsDenied && text.includes("/actions/runs/")) throw new Error("HTTP 403: Actions permission denied");
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
      if (text.includes("BabysitterOpenPullRequests")) {
        const current = pr();
        const node = {
          number: current.number, title: current.title, isDraft: false, headRefOid: current.head.sha, headRefName: current.head.ref,
          baseRefName: current.base.ref, baseRefOid: current.base.sha, mergeable: "MERGEABLE", updatedAt: "2026-10-01T00:00:00Z", url: current.html_url,
          authorAssociation: "MEMBER", totalCommentsCount: 0, author: current.user, headRepository: { nameWithOwner: "acme/app" },
          labels: { nodes: current.labels }, commits: { nodes: [] }, latestReviews: { nodes: [] }, reviewThreads: { nodes: [] },
        };
        return { stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes: openPullRequests ? [node] : [], pageInfo } } } }), stderr: "" };
      }
      const data = text.includes("reviewThreads")
        ? { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo } } } }
        : graphSnapshot();
      if (!text.includes("reviewThreads")) await onAdmission?.();
      return { stdout: JSON.stringify({ data }), stderr: "" };
    }
    if (text.includes("-X PUT") && text.includes("/merge")) return { stdout: JSON.stringify({ status: "merged", details: { sha: "b".repeat(40) } }), stderr: "" };
    if (args.includes("--slurp")) throw new Error("unknown flag: --slurp");
    if (text.includes("/protection/required_status_checks")) {
      expect(args).toContain(". | @json");
      return { stdout: JSON.stringify({ contexts: [], checks: [] }), stderr: "" };
    }
    if (text.includes("/rules/branches/")) {
      expect(args).toContain(".[] | @json");
      const rule = {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "test" }] },
      };
      return {
        stdout: `${JSON.stringify(rule)}\n${JSON.stringify(rule)}`,
        stderr: "",
      };
    }
    if (text.includes("-X PATCH")) return { stdout: JSON.stringify(pr()), stderr: "" };
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path.includes("pulls?state=all&head="))
      return { stdout: (preset.parents ?? []).map((value) => JSON.stringify(value)).join("\n"), stderr: "" };
    if (path === "repos/acme/app")
      return { stdout: JSON.stringify({ delete_branch_on_merge: false }), stderr: "" };
    if (path.startsWith("repos/acme/app/git/ref/heads/"))
      return { stdout: JSON.stringify({ ref: `refs/heads/${pr().base.ref}`, object: { type: "commit", sha: preset.baseBranchHead ?? pr().base.sha } }), stderr: "" };
    const data =
      path.includes("pulls?state") || path === "repos/acme/app/pulls/12"
        ? [pr()]
        : path.includes("/reviews?")
          ? preset.merge ? [] : [
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
                  conclusion: pushed ? null : preset.actionsDenied ? "failure" : "success",
                  ...(preset.actionsDenied ? { app: { slug: "github-actions" }, html_url: "https://github.com/acme/app/actions/runs/1/job/1" } : {}),
                },
                ...extraCheckRuns,
              ]
            : [];
    return { stdout: data.map((value) => JSON.stringify(value)).join("\n"), stderr: "" };
  });
  let workerDirectory: string | undefined;
  const prepare = vi.fn(async (directory: string) => {
    workerDirectory = directory;
    if (preset.gitWorkspace) await promisify(execFile)("git", ["init", "--quiet", directory]);
  });
  const commit = vi.fn(async (directory: string, input: { message: string; paths: string[] }) => remoteBox
    ? await commitGitHubPullRequestWorkspace(directory, input, { expectedHead: head })
    : head);
  const push = vi.fn(async (_target?: string, _options?: { signal?: AbortSignal, beforePush?: (head?: string) => void | Promise<void>, afterPush?: (head: string) => void | Promise<void> }) => {
    pushed = true;
    if (remoteBox) {
      expect(remoteBox.closed).toBe(false);
      head = await git(remoteBox.path, "rev-parse", "HEAD");
      expect(await git(checkout, "rev-parse", "HEAD")).toBe(head);
      expect(await git(checkout, "show", "HEAD:source.ts")).toContain("value = 2");
    } else head = "b".repeat(40);
    return head;
  });
  const github: GitHubHost = {
    identity: () => "repair-bot",
    command,
    channel: (options) => {
      const channel = githubChannel({ ...options, app: github });
      expect(githubChannelIdentity({ github: channel })).toBe(github);
      if (preset.activityBarrier) channel.activity = { update: async () => { await preset.activityBarrier; } };
      return channel;
    },
    environment: async () => {
      throw new Error("Worker must not resolve GitHub credentials");
    },
    access: async () => {
      throw new Error("Worker must not resolve GitHub credentials");
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
        commitRepair: commit,
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
  const events = vi.fn();
  const agent = agentWithColocatedInstructions(defineAgent({
    ...(discovered ? {} : { name: "babysitter" }),
    preset: "babysitter",
    presets: { babysitter },
    github,
    // SAFETY: exercise preservation of a valid custom capability across the preset boundary.
    capabilities: [defineCapability({
      id: "internal-check",
      tools: {
        internalCheck: {
          description: "Check the internal API contract.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: () => ({ checked: true }),
        },
      },
    })] as never,
    // SAFETY: tests pass invalid merge values on purpose to cover runtime validation.
    options: { filter: { labels: { allow: ["repair"] } }, autoMerge, ...(preset.merge === undefined ? {} : { merge: preset.merge as false }), ...(preset.driver ? { driver: preset.driver as "codex" } : {}), ...(preset.mentionAllowlist ? { mentionAllowlist: preset.mentionAllowlist } : {}), ...preset.options },
    ...(preset.box ? { box: { runtime: "trusted-host" as const, requires: ["sh"], ...(preset.boxCheckout ? { checkout: { remote: "https://github.com/acme/other.git", ref: "main", sha: "d".repeat(40) } } : {}) } } : {}),
    driver: { kind: "codex", ...(preset.box ? { providerSettings: { binaryPath: "/bin/true" } } : {}), env: { GH_TOKEN: "must-not-leak", OPENAI_API_KEY: "provider-only", ...preset.driverEnv } },
  }), "Preserve the documented API contract.");
  const runtime = createBabysitterRuntime({
    agent: discovered ? await getAgentFromRegistry("babysitter", { babysitter: async () => ({ default: agent }) }) : agent,
    ...(discovered ? { agentName: preset.agentName ?? "babysitter" } : {}),
    github,
    inboxPath: preset.inboxPath ?? join(root, "inbox.sqlite"),
    repositories: ["acme/app"],
    concurrency: 1,
    activityAuthors: preset.activityBarrier ? ["repair-bot"] : ["vitehub-agent"],
    admission: preset.admission,
    error: errors,
    event: events,
    ...(preset.postPushGraceMs === undefined ? {} : { postPushGraceMs: preset.postPushGraceMs }),
    ...(preset.providerRetryDelayMs === undefined ? {} : { providerRetryDelayMs: preset.providerRetryDelayMs }),
  });
  const passes: Array<{ tools: string[]; descriptions: Record<string, string | undefined>; schemas: Record<string, unknown>; prompt: string; session: string; instructions: string; runtimeMode: string | undefined; approvalPolicy: string | undefined; install?: string }> = [];
  let operation: "resolveReviewThread" | "commitRepair" | "pushRepair" | "requestAutoMerge" | "updatePullRequest" | "readBaseCheckEvidence" | "readBaseCheckLogs" | undefined;
  let operationArguments: Record<string, unknown> = {};
  createProviderRuntime.mockImplementation(async (options: { settings?: { launchArgs?: string }; environment?: NodeJS.ProcessEnv }) => {
    let threadId = `pass-${passes.length}`;
    let finishTurn!: () => void;
    const turnSent = new Promise<void>(resolve => { finishTurn = resolve });
    const configuredEndpoint = options.settings?.launchArgs?.match(/mcp_servers\.t3-code\.url=("[^"]+")/)?.[1];
    let mcp: { endpoint: string; authorizationHeader: string } | undefined = configuredEndpoint
      ? { endpoint: JSON.parse(configuredEndpoint), authorizationHeader: `Bearer ${options.environment?.T3_MCP_BEARER_TOKEN}` }
      : undefined;
    let runtimeMode: string | undefined;
    let approvalPolicy: string | undefined;
    return {
      attachmentsDirectory: join(root, "attachments"),
      close: async () => {},
      stopSession: async () => {},
      interruptTurn: async () => {},
      startSession: async (input: { mcp?: typeof mcp, runtimeMode?: string, approvalPolicy?: string, threadId: string }) => {
        mcp = input.mcp ?? mcp;
        threadId = input.threadId;
        runtimeMode = input.runtimeMode;
        approvalPolicy = input.approvalPolicy;
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
          const listedTools = (await client.listTools()).tools;
          const customCheck = await client.callTool({ name: "internalCheck", arguments: {} });
          expect(customCheck.isError, JSON.stringify(customCheck)).not.toBe(true);
          passes.push({
            tools: listedTools.map((tool) => tool.name),
            descriptions: Object.fromEntries(listedTools.map((tool) => [tool.name, tool.description])),
            schemas: Object.fromEntries(listedTools.map((tool) => [tool.name, tool.inputSchema])),
            prompt: input.input,
            session: threadId,
            instructions: preset.box ? "Box Home instructions" : await readFile(join(workerDirectory!, "AGENTS.md"), "utf8"),
            runtimeMode,
            approvalPolicy,
            install: preset.box ? undefined : await readFile(join(workerDirectory!, ".git", "vitehub-install.json"), "utf8").catch(() => undefined),
          });
          if (operation === "commitRepair" && remoteBox) {
            await writeFile(join(remoteBox.path, "source.ts"), "export const value = 2\n");
          }
          if (operation === "pushRepair" && remoteBox) {
            await writeFile(join(remoteBox.path, "source.ts"), "export const value = 2\n");
            await git(remoteBox.path, "commit", "-am", "repair");
          }
          if (operation) {
            await onRepair?.();
            for (let count = 0; count < (preset.operationCount ?? 1); count++) {
              const result = await client.callTool({ name: operation, arguments: preset.operationInputs?.[count] ?? operationArguments });
              if (preset.expectedOperationErrorAt === count || onAdmission && !preset.allowOperationAfterAdmission) expect(result.isError, JSON.stringify(result)).toBe(true);
              else if (!checkoutController.signal.aborted) expect(result.isError, JSON.stringify(result)).not.toBe(true);
            }
          }
          if (preset.resolveAfterPush) {
            await runtime.inbox.ingest("push-before-resolution", "pull_request", { repository: { full_name: "acme/app" }, action: "synchronize", pull_request: pr() });
            const result = await client.callTool({ name: "resolveReviewThread", arguments: { id: preset.resolveAfterPush } });
            expect(result.isError, JSON.stringify(result)).not.toBe(true);
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
              delta: JSON.stringify(preset.result ?? {
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
  async function reconcile(expectedError?: string) {
    const tracked: Promise<unknown>[] = [];
    await runtime.reconcile("test", {
      track: (value) => {
        tracked.push(value);
      },
    } as Parameters<typeof runtime.reconcile>[1]);
    await Promise.all(tracked);
    if (expectedError) {
      expect(errors).toHaveBeenCalledExactlyOnceWith(expectedError, expect.anything(), expect.anything());
    } else if (!checkoutFailure || checkoutFailure.name === "AbortError" || checkoutFailure.message === "rate limited")
      expect(errors.mock.calls).toEqual([]);
    else expect(errors).toHaveBeenCalledOnce();
  }
  return {
    checkout,
    runtime,
    reconcile,
    passes,
    errors,
    events,
    commit,
    advanceBase: (sha: string) => { baseHead = sha },
    advanceHead: (sha: string) => { head = sha },
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
    onAdmission: (callback: () => void | Promise<void>) => { onAdmission = callback },
    onRepair: (callback: () => void | Promise<void>) => { onRepair = callback },
    closeOnGitHub: () => { openPullRequests = false },
    reportCheckRun: (run: Record<string, unknown>) => { extraCheckRuns.push(run) },
  };
}

describe("Babysitter preset runtime", () => {
  it("retries a direct-source worker blocker only when its source revision changes", async () => {
    vi.stubGlobal("__VITEHUB_AGENT_BUILD_REVISION__", undefined);
    const revision = vi.spyOn(buildRevisions, "agentBuildRevision").mockReturnValue("source-first");
    const result = { disposition: "park", wait: { kind: "external", reason: "Provide writable .git metadata." }, text: "Cannot commit because .git is read-only." };
    const first = await fixture(false, false, { result });
    const inboxPath = join(first.checkout, "..", "inbox.sqlite");
    const admission = async (): Promise<BabysitterAdmissionResult> => ({ accepting: false, accounting: "best-effort-retained-journal",
      limits: resolveBabysitterAdmissionLimits(), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" }, reason: "test" });
    try {
      await first.reconcile();
      await first.runtime.inbox.close();
      const unchanged = await fixture(false, false, { inboxPath, admission });
      try { await unchanged.reconcile(); expect((await unchanged.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting"); }
      finally { await unchanged.runtime.inbox.close(); }
      revision.mockReturnValue("source-second");
      const upgraded = await fixture(false, false, { inboxPath, admission });
      try {
        await upgraded.reconcile();
        expect((await upgraded.runtime.inbox.get("acme/app", 12))?.status).toBe("ready");
        expect(upgraded.passes).toHaveLength(0);
      } finally { await upgraded.runtime.inbox.close(); }
    } finally { await first.runtime.inbox.close(); revision.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("retries an unversioned Agent worker blocker once per package build", async () => {
    const result = { disposition: "park", wait: { kind: "external", reason: "Provide writable .git metadata." }, text: "Cannot commit because .git is read-only." };
    vi.stubGlobal("__VITEHUB_AGENT_BUILD_REVISION__", "build-first");
    const first = await fixture(false, false, { result });
    const inboxPath = join(first.checkout, "..", "inbox.sqlite");
    try {
      await first.reconcile();
      expect((await first.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect(first.passes).toHaveLength(1);
    } finally { await first.runtime.inbox.close(); }
    const admission = async (): Promise<BabysitterAdmissionResult> => ({ accepting: false, accounting: "best-effort-retained-journal", limits: resolveBabysitterAdmissionLimits(), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" }, reason: "test", detail: "Observe recovery with model admission paused" });
    const unchanged = await fixture(false, false, { inboxPath, admission });
    try {
      await unchanged.reconcile();
      expect((await unchanged.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect(unchanged.passes).toHaveLength(0);
    } finally { await unchanged.runtime.inbox.close(); }
    vi.stubGlobal("__VITEHUB_AGENT_BUILD_REVISION__", "build-second");
    const upgraded = await fixture(false, false, { inboxPath, admission });
    try {
      await upgraded.reconcile();
      expect((await upgraded.runtime.inbox.get("acme/app", 12))?.status).toBe("ready");
      expect(upgraded.passes).toHaveLength(0);
    } finally { await upgraded.runtime.inbox.close(); vi.unstubAllGlobals(); }
  });

  it.each(["commitRepair", "pushRepair"] as const)("allows %s across an unrelated repository push", async operation => {
    const f = await fixture(true);
    f.choose(operation, operation === "commitRepair" ? { message: "repair value", paths: ["source.ts"] } : {});
    f.onRepair(async () => {
      await f.runtime.inbox.ingest("other-branch-pushed", "pull_request", {
        repository: { full_name: "acme/app" }, action: "edited",
        pull_request: { ...f.pr(), base: { ...f.pr().base, sha: "d".repeat(40), repo: { ...f.pr().base.repo, pushed_at: "2026-10-08T20:00:00Z", size: 12345, open_issues_count: 20 } } },
      });
    });
    try {
      await f.reconcile();
      if (operation === "commitRepair") expect(f.commit).toHaveBeenCalledOnce();
      else expect(f.push).toHaveBeenCalledOnce();
    } finally { await f.runtime.inbox.close(); }
  });

  it("releases the active owner slot when durable lease cleanup fails", async () => {
    const f = await fixture(false);
    vi.spyOn(f.runtime.inbox, "release").mockRejectedValueOnce(new Error("temporary state store failure"));
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect(f.runtime.workload().running).toBe(0);
      await f.runtime.inbox.ingest("feedback-after-cleanup-failure", "issue_comment", {
        repository: { full_name: "acme/app" }, action: "created", issue: { number: 12, pull_request: {} },
        comment: { id: 700, body: "Please check the new repair requirement.", user: { login: "developer" } },
      });
      await f.reconcile();
      expect(f.passes).toHaveLength(2);
      expect(f.runtime.workload().running).toBe(0);
    } finally { await f.runtime.inbox.close(); }
  });

  it("parks model work until the recorded provider quota cooldown ends", async () => {
    const f = await fixture(false);
    const until = Date.now() + 60 * 60_000;
    try {
      await f.runtime.inbox.seed("acme/app", f.pr());
      await f.runtime.inbox.setMeta("provider-quota-blocked-until", until);
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toBe(until);
    } finally { await f.runtime.inbox.close(); }
  });

  it("retargets ordinary stack work while a provider quota cooldown blocks models", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    try {
      await f.runtime.inbox.setMeta("provider-quota-blocked-until", Date.now() + 60 * 60_000);
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(true);
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("rechecks a provider cooldown recorded during owner hydration", async () => {
    const f = await fixture(false);
    const until = Date.now() + 60 * 60_000;
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.some(arg => arg.includes("/check-runs?"))) await f.runtime.inbox.setMeta("provider-quota-blocked-until", until);
      return await command(args, request);
    });
    try {
      await f.reconcile();
      expect(createProviderRuntime.mock.calls.length).toBe(0);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toBe(until);
    } finally { await f.runtime.inbox.close(); }
  });

  it("rechecks a provider cooldown recorded during owner hydration after it expires", async () => {
    const f = await fixture(false);
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.some(arg => arg.includes("/check-runs?"))) await f.runtime.inbox.setMeta("provider-quota-blocked-until", 0);
      return await command(args, request);
    });
    try {
      await f.runtime.inbox.setMeta("provider-quota-blocked-until", Date.now() + 60 * 60_000);
      await f.reconcile();
      expect(createProviderRuntime.mock.calls.length).toBe(1);
    } finally { await f.runtime.inbox.close(); }
  });

  it("rechecks a provider cooldown recorded during owner hydration or workspace preparation", async () => {
    const f = await fixture(false);
    const until = Date.now() + 60 * 60_000;
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async (...args) => {
      const result = await prepare(...args);
      await f.runtime.inbox.setMeta("provider-quota-blocked-until", until);
      return result;
    });
    try {
      await f.reconcile();
      expect(createProviderRuntime.mock.calls.length).toBe(0);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toBe(until);
    } finally { await f.runtime.inbox.close(); }
  });

  it("retargets ordinary stack work while model admission is blocked", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents, admission: async () => ({ accepting: false, accounting: "best-effort-retained-journal", hostOnly: true, reason: "token-budget-hourly", limits: resolveBabysitterAdmissionLimits(), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } }) });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(true);
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["closed", "base", "head", "lease"])("does not retarget a child whose %s changes during parent lookup", async change => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    const command = f.command.getMockImplementation()!;
    let changed = false;
    f.command.mockImplementation(async (args, request) => {
      if (args.some(arg => arg.includes("pulls?state=all&head="))) {
        changed = true;
        if (change === "lease") {
          const snapshot = (await f.runtime.inbox.get("acme/app", 12))!;
          await f.runtime.inbox.release({ snapshot, token: snapshot.lease!, generation: snapshot.generation });
        }
      }
      if (changed && args.includes("repos/acme/app/pulls/12") && !args.includes("PATCH")) {
        const pr = f.pr();
        const current = change === "closed" ? { ...pr, state: "closed" }
          : change === "base" ? { ...pr, base: { ...pr.base, ref: "maintainer-target" } }
          : change === "head" ? { ...pr, head: { ...pr.head, sha: "d".repeat(40) } } : pr;
        return { stdout: JSON.stringify(current), stderr: "" };
      }
      return await command(args, request);
    });
    try {
      await f.reconcile();
      expect(changed).toBe(true);
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false);
      expect(f.passes).toHaveLength(0);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([false, true])("rechecks dynamic host admission after dependency setup, Box=%s", async box => {
    let accepting = true;
    const retryAt = Date.now() + 300_000;
    const admission = vi.fn(async () => ({ accepting, retryAt, accounting: "best-effort-retained-journal" as const, hostOnly: true, reason: "token-budget-hourly" as const, limits: resolveBabysitterAdmissionLimits(), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } }));
    const f = await fixture(false, false, { box, admission });
    const installOriginal = githubInstalls.installGitHubPullRequestWorkspace;
    const install = vi.spyOn(githubInstalls, "installGitHubPullRequestWorkspace").mockImplementationOnce(async (...args) => { await installOriginal(...args); accepting = false; });
    try {
      await f.reconcile();
      expect(install).toHaveBeenCalledOnce();
      expect(f.passes).toHaveLength(0);
      expect(admission.mock.calls.length).toBeGreaterThan(1);
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(current.status).toBe("waiting");
      expect(current.wait?.retryAt).toBe(retryAt);
      expect(current.lease).toBeNull();
    } finally { install.mockRestore(); await f.runtime.inbox.close(); }
  });

  it("rechecks Box admission after run metadata preparation", async () => {
    let accepting = true;
    const retryAt = Date.now() + 300_000;
    const admission = vi.fn(async () => ({ accepting, retryAt, accounting: "best-effort-retained-journal" as const, hostOnly: true, reason: "token-budget-hourly" as const, limits: resolveBabysitterAdmissionLimits(), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } }));
    const f = await fixture(false, false, { box: true, admission });
    const createOriginal = githubRuns.createGitHubPullRequestRun;
    const createRun = vi.spyOn(githubRuns, "createGitHubPullRequestRun").mockImplementationOnce(async (...args) => { const run = await createOriginal(...args); accepting = false; return run; });
    try {
      await f.reconcile();
      expect(createRun).toHaveBeenCalledOnce();
      expect(f.passes).toHaveLength(0);
      expect(admission.mock.calls.length).toBeGreaterThan(1);
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(current.status).toBe("waiting");
      expect(current.wait?.retryAt).toBe(retryAt);
      expect(current.lease).toBeNull();
    } finally { createRun.mockRestore(); await f.runtime.inbox.close(); }
  });

  it("keeps a recovery claim parked when admission permits only host work", async () => {
    const f = await fixture(false, false, { admission: async () => ({ accepting: false, accounting: "best-effort-retained-journal", hostOnly: true, reason: "token-budget-hourly", limits: resolveBabysitterAdmissionLimits(), state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } }) });
    try {
      await f.runtime.inbox.seed("acme/app", f.pr());
      const [claim] = await f.runtime.inbox.claim(1);
      await f.runtime.inbox.finish(claim!, { text: "Waiting for CI", wait: createCheckWait(claim!.snapshot, { workerAuthors: new Set(), noFindingsReviews: [] }) });
      const waiting = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.wake(waiting, "ci-recovery", { recovery: true });
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.lastResult).toContain("Recovered CI is healthy");
      const healthyWait = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(healthyWait.wait?.retryAt).toBeUndefined();
      expect(await f.runtime.inbox.wake(healthyWait, "new-feedback")).toBe(true);
      expect((await f.runtime.inbox.get("acme/app", 12))?.recoveryHead).toBeUndefined();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps permission fallback pending through interruption and consumes it after a durable pass", async () => {
    const f = await fixture(false, false, { actionsDenied: true });
    const key = `ci-permission-fallback:v1:acme/app:${f.pr().head.sha}`;
    try {
      f.failCheckout(new DOMException("interrupted", "AbortError"));
      await f.reconcile();
      expect(await f.runtime.inbox.meta(key)).toHaveProperty("pendingAt");
      expect(await f.runtime.inbox.meta(key)).not.toHaveProperty("consumedAt");
      const restarted = await fixture(false, false, { actionsDenied: true });
      try {
        await restarted.runtime.inbox.setMeta(key, await f.runtime.inbox.meta(key));
        await restarted.reconcile();
        expect(restarted.passes).toHaveLength(1);
        expect(await restarted.runtime.inbox.meta(key)).toHaveProperty("consumedAt");
      } finally { await restarted.runtime.inbox.close(); }
    } finally { await f.runtime.inbox.close(); }
  });

  it("retains permission fallback when new check evidence prevents recording the pass", async () => {
    const f = await fixture(false, false, { actionsDenied: true, result: { disposition: "park", text: "Waiting for checks", wait: { kind: "checks", headSha: "a".repeat(40) } } });
    const key = `ci-permission-fallback:v1:acme/app:${f.pr().head.sha}`;
    const finish = f.runtime.inbox.finish.bind(f.runtime.inbox);
    let changed = false;
    vi.spyOn(f.runtime.inbox, "finish").mockImplementation(async (claim, result) => {
      if (!changed && f.passes.length) {
        changed = true;
        await f.runtime.inbox.ingest("pending-check-during-pass", "check_run", {
          repository: { full_name: "acme/app" }, action: "created",
          check_run: { id: 88, head_sha: f.pr().head.sha, name: "other", status: "in_progress", pull_requests: [{ number: 12 }] },
        });
      }
      return await finish(claim, result);
    });
    try {
      await f.reconcile();
      expect(changed).toBe(true);
      expect(f.passes).toHaveLength(1);
      expect(await f.runtime.inbox.meta(key)).not.toHaveProperty("consumedAt");
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("ready");
    } finally { await f.runtime.inbox.close(); }
  });

  it("processes new feedback after a same-head permission fallback was consumed", async () => {
    const f = await fixture(false, false, { actionsDenied: true });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      await f.runtime.inbox.ingest("new-permission-feedback", "issue_comment", {
        repository: { full_name: "acme/app" }, action: "created", issue: { number: 12, pull_request: {} },
        comment: { id: 73, body: "Please repair the additional validation finding", user: { login: "developer" } },
      });
      await f.reconcile();
      expect(f.passes).toHaveLength(2);
    } finally { await f.runtime.inbox.close(); }
  });

  it("retains a worker blocker instead of replacing it with an idle CI permission wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reason = "Host commitRepair repeatedly rejects dependency state despite successful refreshDependencies and repeated focused validation.";
    const f = await fixture(false, false, { actionsDenied: true, result: { disposition: "park", text: reason, wait: { kind: "external", reason } } });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.reason).toBe(reason);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.reason).toBe(reason);
    } finally { await f.runtime.inbox.close(); vi.useRealTimers(); }
  });

  it.each(["commitRepair", "pushRepair"] as const)("rejects %s after the prepared conflict base changes", async operation => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { mergeableState: "dirty" });
    f.choose(operation, operation === "commitRepair" ? { message: "resolve base conflict", paths: ["source.ts"] } : {});
    f.onAdmission(() => { f.advanceBase("d".repeat(40)); });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
      const retry = await f.runtime.inbox.get("acme/app", 12);
      expect(retry?.status).toBe("ready");
      expect(retry?.refresh).toBe(true);
      f.choose(undefined);
      vi.setSystemTime(retry!.nextAt + 1);
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.pr?.base?.sha).toBe("d".repeat(40));
    } finally { await f.runtime.inbox.close(); vi.useRealTimers(); }
  });

  it("bounds stalled readiness hooks and contains rejection and cancellation", async () => {
    await expect(boundedMergeReady(() => new Promise(() => {}), new AbortController().signal, 5)).resolves.toBe("merge readiness timed out");
    await expect(boundedMergeReady(() => Promise.reject(new Error("offline")), new AbortController().signal)).resolves.toBe("merge readiness check failed");
    const controller = new AbortController();
    const pending = boundedMergeReady(() => new Promise(() => {}), controller.signal);
    controller.abort(new Error("stopped"));
    await expect(pending).resolves.toBe("merge readiness cancelled");
  });

  it("retries a reviewed custom gate without another model pass", async () => {
    let ready = false;
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => ready || "approval pending" }, result: { disposition: "park", text: "Reviewed", reviewedHead: "a".repeat(40) } });
    try {
      await f.reconcile();
      const waiting = await f.runtime.inbox.get("acme/app", 12);
      expect(waiting?.wait?.retryAt).toBeTypeOf("number");
      expect(await f.runtime.inbox.waitsToEvaluate(true)).toHaveLength(1);
      ready = true;
      const now = vi.spyOn(Date, "now").mockReturnValue(waiting!.wait!.retryAt! + 1);
      try { await f.reconcile(); } finally { now.mockRestore(); }
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("terminal");
    } finally { await f.runtime.inbox.close(); }
  });

  it("does not retain a merge assessment for an external wait", async () => {
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => "approval pending" }, result: { disposition: "park", text: "Reviewed", reviewedHead: "a".repeat(40), wait: { kind: "external", reason: "Needs approval" } } });
    try {
      await f.reconcile();
      expect(await f.runtime.inbox.meta("review-assessment:acme/app#12")).toBeNull();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.kind).toBe("external");
    } finally { await f.runtime.inbox.close(); }
  });

  it("preserves an external prerequisite across a repair push and green checks", async () => {
    let ready = false;
    const reason = "Publish the required dependency release before merging.";
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => ready || "repair pending" },
      result: { disposition: "park", text: reason, wait: { kind: "external", reason } } });
    f.choose("pushRepair");
    try {
      await f.reconcile();
      const head = f.pr().head.sha;
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait).toMatchObject({ kind: "external", headSha: head, reason });
      expect(await f.runtime.inbox.meta("review-assessment:acme/app#12")).toBeNull();
      f.choose(undefined);
      ready = true;
      await f.runtime.inbox.ingest("own-prerequisite-push", "pull_request", { repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr() });
      await f.runtime.inbox.ingest("prerequisite-checks-green", "check_run", { repository: { full_name: "acme/app" }, action: "completed",
        check_run: { id: 1, name: "test", head_sha: head, status: "completed", conclusion: "success", app: { id: 1 }, pull_requests: [{ number: 12 }] } });
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect(f.command.mock.calls.some(([args]) => args.includes("PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["read", "metadata"])("preserves a pushed external blocker when dependency %s fails", async failure => {
    const wake = { kind: "checks", repository: "acme/app", headSha: "e".repeat(40) };
    const reason = "Dependency release required.";
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => "repair pending" },
      result: { disposition: "park", text: reason, wait: { kind: "external", reason, wake } } });
    f.choose("pushRepair");
    f.onRepair(async () => {
      await f.runtime.inbox.setMeta("review-assessment:acme/app#12", { version: 2, feedback: [] });
    });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (failure === "read" && args.join(" ").includes(`/commits/${wake.headSha}/`)) throw new Error("Dependency read unavailable");
      return await command(args, request);
    });
    const setMeta = f.runtime.inbox.setMeta.bind(f.runtime.inbox);
    vi.spyOn(f.runtime.inbox, "setMeta").mockImplementation(async (key, value) => {
      if (failure === "metadata" && key === "dependency:acme/app#12") throw new Error("Dependency metadata unavailable");
      return await setMeta(key, value);
    });
    try {
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait).toMatchObject({ kind: "external", headSha: f.pr().head.sha, reason, wake });
      expect(await f.runtime.inbox.meta("review-assessment:acme/app#12")).toBeNull();
      expect(f.events.mock.calls.some(([name]) => name === "babysitter.external_wait.setup_failed")).toBe(true);
    } finally { await f.runtime.inbox.close(); }
  });

  it("uses resolved thread evidence for a pushed external wait", async () => {
    const f = await fixture(false, false, { resolveAfterPush: "PRRT_1",
      result: { disposition: "park", text: "Release pending", wait: { kind: "external", reason: "Release pending" } } });
    f.choose("pushRepair");
    let resolved = false;
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const query = args.join(" ");
      if (query.includes("reviewThreads")) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: "PRRT_1", isResolved: resolved, comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }), stderr: "" };
      if (query.includes("node(id:")) return { stdout: JSON.stringify({ data: { node: { pullRequest: { id: "PR_12" }, isResolved: resolved } } }), stderr: "" };
      if (query.includes("resolveReviewThread(input:")) {
        resolved = true;
        return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1" } } } }), stderr: "" };
      }
      return await command(args, request);
    });
    try {
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.threads[0]?.isResolved).toBe(true);
      await f.runtime.inbox.ingest("resolved-push", "pull_request", { repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr() });
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.kind).toBe("external");
    } finally { await f.runtime.inbox.close(); }
  });

  it("does not acknowledge maintainer prerequisites merely because a repair was pushed", async () => {
    let ready = false;
    const f = await fixture(false, false, { merge: { strategy: "direct", ready: () => ready || "repair pending" } });
    const comment = { id: 201, body: "Before merging, publish the required dependency release.", user: { login: "maintainer" } };
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => args.join(" ").includes("/issues/12/comments")
      ? { stdout: JSON.stringify(comment), stderr: "" } : command(args, request));
    f.choose("pushRepair");
    try {
      await f.runtime.inbox.ingest("prerequisite-opened", "pull_request", { repository: { full_name: "acme/app" }, action: "opened", pull_request: f.pr() });
      await f.runtime.inbox.ingest("maintainer-prerequisite", "issue_comment", { repository: { full_name: "acme/app" }, action: "created",
        issue: { number: 12, pull_request: {} }, comment });
      await f.reconcile();
      expect(await f.runtime.inbox.meta("review-assessment:acme/app#12")).toBeUndefined();
      f.choose(undefined);
      ready = true;
      const head = f.pr().head.sha;
      f.reportCheckRun({ id: 1, name: "test", head_sha: head, status: "completed", conclusion: "success" });
      await f.runtime.inbox.ingest("own-unassessed-push", "pull_request", { repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr() });
      await f.runtime.inbox.ingest("unassessed-checks-green", "check_run", { repository: { full_name: "acme/app" }, action: "completed",
        check_run: { id: 1, name: "test", head_sha: head, status: "completed", conclusion: "success", app: { id: 1 }, pull_requests: [{ number: 12 }] } });
      await f.reconcile();
      expect(f.passes).toHaveLength(2);
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).not.toBe("terminal");
      expect(f.command.mock.calls.some(([args]) => args.includes("PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it("ignores legacy repair assessments when a maintainer prerequisite needs review", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    const comment = { id: 202, body: "Before merging, publish the required dependency release.", user: { login: "maintainer" } };
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => args.join(" ").includes("/issues/12/comments")
      ? { stdout: JSON.stringify(comment), stderr: "" } : command(args, request));
    try {
      await f.runtime.inbox.ingest("legacy-prerequisite-opened", "pull_request", { repository: { full_name: "acme/app" }, action: "opened", pull_request: f.pr() });
      await f.runtime.inbox.ingest("legacy-maintainer-prerequisite", "issue_comment", { repository: { full_name: "acme/app" }, action: "created",
        issue: { number: 12, pull_request: {} }, comment });
      const snapshot = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.setMeta("review-assessment:acme/app#12", { feedback: feedbackFingerprints(snapshot) });
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).not.toBe("terminal");
      expect(f.command.mock.calls.some(([args]) => args.includes("PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it("merges a ready PR directly before any model pass", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    try {
      await f.reconcile();
      const merge = f.command.mock.calls.find(([args]) => args.join(" ").includes("-X PUT"));
      expect(merge?.[0]).toEqual(expect.arrayContaining(["repos/acme/app/pulls/12/merge-async", "merge_method=squash", "merge_action=direct_merge", "bypass_rules=false", `sha=${"a".repeat(40)}`]));
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("terminal");
    } finally { await f.runtime.inbox.close(); }
  });

  it("recovers claimed execution and wait evaluation from stalled readiness", async () => {
    const ready = vi.fn(() => new Promise<true>(() => {}));
    const f = await fixture(false, false, { merge: { strategy: "direct", ready }, result: { disposition: "park", text: "Waiting", wait: { kind: "checks", headSha: "a".repeat(40) } } });
    try {
      await f.reconcile();
      expect(ready).toHaveBeenCalled();
      expect(createProviderRuntime).toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait).toBeDefined();
      const calls = ready.mock.calls.length;
      await f.runtime.inbox.ingest("readiness-check-completed", "check_run", {
        repository: { full_name: "acme/app" }, action: "completed",
        check_run: { id: 99, name: "test", head_sha: f.pr().head.sha, status: "completed", conclusion: "success", pull_requests: [{ number: 12 }] },
      });
      await f.reconcile();
      expect(ready.mock.calls.length).toBeGreaterThan(calls);
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("-X PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  }, 20_000);

  it("persists an asynchronous merge and waits for confirmed completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify({ status: "pending", details: { uuid, expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }), stderr: "" };
      if (args.includes(`repos/acme/app/pulls/12/merge-async/${uuid}`)) return { stdout: JSON.stringify({ status: "merged", details: { sha: "b".repeat(40) } }), stderr: "" };
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: uuid });
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("terminal");
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it.each([404, 502])("reconciles an unavailable asynchronous result with HTTP %s", async status => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
    f.command.mockImplementation(async (args, request) => {
      if (args.includes(`repos/acme/app/pulls/12/merge-async/${uuid}`)) throw new Error(`gh: Merge result unavailable (HTTP ${status})`);
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify({ status: "pending", details: { uuid, expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }), stderr: "" };
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: uuid });
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      if (status === 404) expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      else expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: uuid });
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).not.toBe("terminal");
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it.each([
    ["polled", true], ["polled", false], ["polled", "unavailable"],
    ["immediate", true], ["immediate", false], ["immediate", "unavailable"],
  ] as const)("reconciles %s enqueued results with queue membership %s", async (mode, membership) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
    f.command.mockImplementation(async (args, request) => {
      if (args.includes(`repos/acme/app/pulls/12/merge-async/${uuid}`)) return { stdout: JSON.stringify({ status: "enqueued", details: {} }), stderr: "" };
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify(mode === "immediate" ? { status: "enqueued", details: {} } : { status: "pending", details: { uuid, expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }), stderr: "" };
      if (args.some(arg => arg.includes("mergeQueueEntry"))) {
        if (membership === "unavailable") throw new Error("Queue read unavailable");
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN", headRefOid: "a".repeat(40), mergeQueueEntry: membership ? { id: "queued" } : null, timelineItems: { nodes: [] } } } } }), stderr: "" };
      }
      return command(args, request);
    });
    try {
      await f.reconcile();
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ enqueued: true });
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it.each(["removed", "same-second-removal", "old-removal", "wrong-head-removal", "readded", "head-changed", "merged", "closed"])("reconciles enqueued merges only with definitive %s evidence", async outcome => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Math.floor(Date.now() / 1000) * 1000 + 500;
    vi.setSystemTime(startedAt);
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("repos/acme/app/pulls/12/merge-async")) return { stdout: JSON.stringify({ status: "enqueued", details: {} }), stderr: "" };
      if (args.some(arg => arg.includes("mergeQueueEntry"))) {
        const removed = { __typename: "RemovedFromMergeQueueEvent", createdAt: new Date(startedAt + (outcome === "old-removal" ? -60_000 : outcome === "same-second-removal" ? -500 : 1_000)).toISOString(), beforeCommit: { oid: (outcome === "wrong-head-removal" ? "b" : "a").repeat(40) } };
        const event = outcome === "readded" ? { __typename: "AddedToMergeQueueEvent" } : removed;
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
          state: outcome === "merged" ? "MERGED" : outcome === "closed" ? "CLOSED" : "OPEN",
          headRefOid: (outcome === "head-changed" ? "b" : "a").repeat(40), mergeQueueEntry: null,
          timelineItems: { nodes: [event] },
        } } } }), stderr: "" };
      }
      return command(args, request);
    });
    try {
      await f.reconcile();
      vi.setSystemTime(startedAt + 31_000);
      await f.reconcile();
      const definitive = ["head-changed", "merged", "closed"].includes(outcome);
      if (definitive) expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      else expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ enqueued: true });
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe(outcome === "merged" || outcome === "closed" ? "terminal" : definitive ? "ready" : "waiting");
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("parks an uncertain async merge while live mergeability is recalculated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    let uncertain = false;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("PUT")) { uncertain = true; throw new Error("Connection reset after delivery"); }
      const result = await command(args, request);
      if (uncertain && args.includes("repos/acme/app/pulls/12")) return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), mergeable: null, mergeable_state: "unknown" }) };
      return result;
    });
    try {
      await f.reconcile();
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeDefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("parks model work until GitHub computes definitive mergeability", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture();
    const command = f.command.getMockImplementation()!;
    let uncertain = true;
    f.command.mockImplementation(async (args, request) => {
      const result = await command(args, request);
      if (uncertain && args.includes("repos/acme/app/pulls/12")) return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), mergeable: null, mergeable_state: "unknown" }) };
      return result;
    });
    try {
      await f.reconcile();
      expect(createProviderRuntime.mock.calls.length).toBe(0);
      const current = await f.runtime.inbox.get("acme/app", 12);
      expect(current?.status).toBe("waiting");
      expect(current?.lease).toBeNull();
      expect(current?.wait?.retryAt).toBeGreaterThan(Date.now());
      expect(current?.lastResult).toMatch(/mergeability/i);
      uncertain = false;
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(createProviderRuntime.mock.calls.length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("preserves the dependency installation opt-out in the configured preset", () => {
    const agent = defineAgent({ extends: babysitter, options: { install: false } });
    expect(agent.install).toBe(false);
    expect(agent.options.install).toBe(false);
  });

  it.each(["repos/acme/app", "repos/acme/app/pulls?state=open&base=fix&per_page=100"])("parks the claim when branch safety read %s fails", async (path) => {
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes(path)) throw new Error("GitHub temporarily unavailable");
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toBeGreaterThan(Date.now());
      expect(await f.runtime.inbox.claim(1)).toEqual([]);
      expect(f.command.mock.calls.some(([args]) => args.includes("PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  }, 30_000);

  it("keeps an unconfirmed direct merge fenced for reconciliation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const result = await command(args, request);
      if (args.includes("-X") && args.includes("PUT")) {
        if (f.command.mock.calls.filter(([call]) => call.includes("PUT")).length === 1) throw new Error("Connection reset after merge request delivery");
        throw Object.assign(new Error("gh: Merge already pending (HTTP 409)"), { stdout: JSON.stringify({ status: "pending", details: { uuid: "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42", expected_head_sha: "a".repeat(40), merge_action: "direct_merge", merge_method: "squash" } }) });
      }
      return result;
    });
    try {
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeDefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).not.toBe("terminal");
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      vi.setSystemTime(Date.now() + 31_000);
      await f.reconcile();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toMatchObject({ requestId: "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42" });
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(2);
    } finally { vi.useRealTimers(); await f.runtime.inbox.close(); }
  });

  it("releases a rejected merge claim and records a timed retry", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      if (args.includes("PUT")) throw new Error("gh: Base branch was modified. Review and try the merge again (HTTP 405)");
      return command(args, request);
    });
    try {
      await f.reconcile();
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBeNull();
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.retryAt).toEqual(expect.any(Number));
      await f.reconcile();
      expect(f.command.mock.calls.filter(([args]) => args.includes("PUT"))).toHaveLength(1);
      expect(await f.runtime.inbox.directMergeAttempt("acme/app", 12)).toBeUndefined();
    } finally { await f.runtime.inbox.close(); }
  });

  it("does not directly merge when feedback changes during the live readiness read", async () => {
    const f = await fixture(false, false, { merge: "direct" });
    const command = f.command.getMockImplementation()!;
    let delivered = false;
    f.command.mockImplementation(async (args, request) => {
      const result = await command(args, request);
      if (!delivered && args.includes("repos/acme/app/pulls/12")) {
        const snapshot = await f.runtime.inbox.get("acme/app", 12);
        if (snapshot?.hydrated && snapshot.lease) {
          delivered = true;
          await f.runtime.inbox.ingest("merge-race-feedback", "issue_comment", {
            repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: {} },
            action: "created", comment: { id: 99, body: "Please address this before merging", user: { login: "developer" } },
          });
        }
      }
      return result;
    });
    try {
      await f.reconcile();
      expect(delivered).toBe(true);
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("-X PUT"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([
    ["GitHub reports the PR is not clean", { merge: "direct", mergeableState: "blocked" }],
    ["merge.ready vetoes the merge", { merge: { strategy: "direct", ready: () => "needs a maintainer approval" } }],
  ] as const)("runs a normal pass when %s", async (_case, preset) => {
    const f = await fixture(false, false, preset);
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("-X PUT"))).toBe(false);
      expect(createProviderRuntime).toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("uses the configured merge method", async () => {
    const f = await fixture(false, false, { merge: { strategy: "direct", method: "rebase" } });
    try {
      await f.reconcile();
      const merge = f.command.mock.calls.find(([args]) => args.join(" ").includes("-X PUT"));
      expect(merge?.[0]).toContain("merge_method=rebase");
    } finally { await f.runtime.inbox.close(); }
  });

  it("validates driver and merge options when the Agent is defined", () => {
    // @ts-expect-error -- an unknown merge mode is rejected at runtime too.
    expect(() => defineAgent({ extends: babysitter, options: { merge: "yes" } })).toThrow(/merge must be/);
    expect(() => defineAgent({ extends: babysitter, options: { merge: "direct", autoMerge: true } })).toThrow(/deprecated/);
    // @ts-expect-error -- only provider Drivers can repair a checkout.
    expect(() => defineAgent({ extends: babysitter, options: { driver: "model" } })).toThrow(/driver must be/);
    expect(() => defineAgent({ extends: babysitter, options: { noFindingsReviews: [""] } })).toThrow(/noFindingsReviews cannot contain an empty prefix/);
    expect(() => defineAgent({ extends: babysitter, options: { merge: { strategy: "direct", method: "fast-forward" as "squash" } } })).toThrow(/merge.method/);
  });

  it("tells the worker about the host install and what a push records, once each", () => {
    for (const sentence of [
      "When the host installed dependencies, .git/vitehub-install.json records the command and result",
      "A push records every supplied finding as handled, so fix or explicitly reject each one before pushing.",
    ]) expect(babysitterInstructions.split(sentence)).toHaveLength(2);
  });

  it("validates the throughput options when the Agent is defined", () => {
    expect(() => defineAgent({ extends: babysitter, options: { ignoreFeedbackAuthors: [" "] } })).toThrow(/ignoreFeedbackAuthors must list GitHub logins/);
    for (const noProgressBudget of [0, 1.5]) {
      expect(() => defineAgent({ extends: babysitter, options: { noProgressBudget } })).toThrow(/noProgressBudget must be a positive integer or false/);
    }
    expect(() => defineAgent({ extends: babysitter, options: { deferWhilePending: "yes" as unknown as boolean } })).toThrow(/deferWhilePending must be a boolean/);
    expect(() => defineAgent({ extends: babysitter, options: { install: { command: "" } } })).toThrow(/install must be a boolean or \{ command, args, cache \}/);
    expect(() => defineAgent({ extends: babysitter, options: { install: { args: ["install"] } } })).toThrow(/install must be/);
    expect(() => defineAgent({ extends: babysitter, options: { install: { cache: { entries: 0 } } } })).toThrow(/install must be/);
    expect(() => defineAgent({ extends: babysitter, options: { install: { cache: { directory: "" } } } })).toThrow(/install must be/);
    expect(() => defineAgent({ extends: babysitter, options: { install: { cache: { directory: "/var/cache/vitehub", entries: 4 } } } })).not.toThrow();
    expect(() => defineAgent({ extends: babysitter, options: { install: { cache: false } } })).not.toThrow();
    expect(() => defineAgent({ extends: babysitter, options: { install: { command: "pnpm", args: ["install", 1 as unknown as string] } } })).toThrow(/install must be/);
    expect(() => defineAgent({ extends: babysitter, options: { admission: { inputTokens: { daily: 1e9 }, minFreeTmpMb: false, paused: false, check: () => undefined } } })).not.toThrow();
    expect(() => defineAgent({ extends: babysitter, options: { admission: { inputTokens: { hourly: -1 } } } })).toThrow(/admission must be/);
    expect(() => defineAgent({ extends: babysitter, options: { admission: { paused: "yes" as unknown as boolean } } })).toThrow(/admission must be/);
    expect(() => defineAgent({ extends: babysitter, options: { ignoreFeedbackAuthors: ["vercel[bot]"], noProgressBudget: false, deferWhilePending: false, install: { command: "pnpm", args: ["install"] } } })).not.toThrow();
  });

  it("applies the no-progress budget to passes on one head", async () => {
    for (const [noProgressBudget, limit] of [[undefined, 3], [2, 2], [false, undefined]] as const) {
      const f = await fixture(false, false, noProgressBudget === undefined ? {} : { options: { noProgressBudget } });
      try {
        await f.reconcile();
        expect(f.passes).toHaveLength(1);
        expect((await f.runtime.inbox.get("acme/app", 12))?.progressBudget?.limit).toBe(limit);
      } finally { await f.runtime.inbox.close(); }
    }
  });

  it("defers a pass while a review check runs, unless deferral is disabled", async () => {
    for (const deferWhilePending of [true, false]) {
      const f = await fixture(false, false, { options: { reviewChecks: ["review-bot"], deferWhilePending } });
      f.reportCheckRun({ id: 5, name: "review-bot", head_sha: f.pr().head.sha, status: "in_progress", conclusion: null, app: { id: 6 } });
      f.reportCheckRun({ id: 6, name: "lint", head_sha: f.pr().head.sha, status: "completed", conclusion: "failure", app: { id: 6 } });
      f.reportCheckRun({ id: 7, name: "lint", head_sha: f.pr().head.sha, status: "completed", conclusion: "success", app: { id: 6 } });
      try {
        await f.reconcile();
        expect(f.passes).toHaveLength(deferWhilePending ? 0 : 1);
        if (deferWhilePending) {
          expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.defer).toBe("checks");
          expect(f.events).toHaveBeenCalledWith("babysitter.wait.kept", expect.objectContaining({ reason: "deferred:review checks", avoided_invocation: true }));
        }
      } finally { await f.runtime.inbox.close(); }
    }
  });

  it("does not park a completed pass for a superseded pending check", async () => {
    const f = await fixture();
    f.reportCheckRun({ id: 6, name: "lint", head_sha: f.pr().head.sha, status: "in_progress", app: { id: 6 } });
    f.reportCheckRun({ id: 7, name: "lint", head_sha: f.pr().head.sha, status: "completed", conclusion: "success", app: { id: 6 } });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      const current = await f.runtime.inbox.get("acme/app", 12);
      expect(current?.status).toBe("ready");
      expect(current?.wait).toBeUndefined();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps review feedback unassessed after a repair push", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      const assessment = await f.runtime.inbox.meta("review-assessment:acme/app#12");
      // A push receipt proves publication, not that every supplied requirement is fulfilled.
      expect(assessment).toBeUndefined();
    } finally { await f.runtime.inbox.close(); }
  });

  it("installs dependencies on the host with a scrubbed environment before the provider starts", async () => {
    const script = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), env: process.env }))";
    const directory = await mkdtemp(join(tmpdir(), "vitehub-babysitter-install-"));
    roots.push(directory);
    const report = join(directory, "install.json");
    const g = await fixture(false, false, { gitWorkspace: true, driverEnv: { NODE_OPTIONS: "--max-old-space-size=1024" }, options: { install: { command: process.execPath, args: ["-e", script, report] } } });
    try {
      await g.reconcile();
      expect(g.passes).toHaveLength(1);
      const installed = JSON.parse(await readFile(report, "utf8"));
      expect(installed.env).toMatchObject({ CI: "1", NODE_OPTIONS: "--max-old-space-size=1024" });
      expect(installed.env.PATH).toBeTruthy();
      expect(installed.env).not.toHaveProperty("GH_TOKEN");
      expect(installed.env).not.toHaveProperty("OPENAI_API_KEY");
      // The model reads the result from the Git directory of its workspace.
      const record = JSON.parse(g.passes[0]!.install!);
      expect(record).toMatchObject({ command: `${process.execPath} -e ${script} ${report}`, ok: true });
      expect(g.events).toHaveBeenCalledWith("babysitter.install.finished", expect.objectContaining({ ok: true, pullRequest: 12 }));
    } finally { await g.runtime.inbox.close(); }
  });

  it("detects the package manager from the lockfile and skips the install without one", async () => {
    const f = await fixture(false, false, { gitWorkspace: true, options: { install: false } });
    try {
      await f.reconcile();
      expect(f.events).not.toHaveBeenCalledWith("babysitter.install.finished", expect.anything());
    } finally { await f.runtime.inbox.close(); }
    const g = await fixture(false, false, { gitWorkspace: true });
    try {
      await g.reconcile();
      expect(g.passes).toHaveLength(1);
      expect(g.passes[0]!.install).toBeUndefined();
      expect(g.events).not.toHaveBeenCalledWith("babysitter.install.finished", expect.anything());
    } finally { await g.runtime.inbox.close(); }
    // The guarded installer uses a pinned Corepack command.
    const bin = await mkdtemp(join(tmpdir(), "vitehub-babysitter-bin-"));
    roots.push(bin);
    await writeFile(join(bin, "corepack"), `#!/bin/sh\necho "$@" > "${join(bin, "args")}"\nexit 3\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const h = await fixture(false, false, { gitWorkspace: true });
    await writeFile(join(h.checkout, "package.json"), "{}");
    await writeFile(join(h.checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    try {
      await h.reconcile("babysitter.install.failed");
      expect((await readFile(join(bin, "args"), "utf8")).trim()).toBe("pnpm@10.34.6 install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.manage-package-manager-versions=false");
      // Failed installs retain the guarded host wait and never dispatch a worker.
      expect(h.passes).toHaveLength(0);
      expect((await h.runtime.inbox.get("acme/app", 12))?.wait).toMatchObject({ kind: "external" });
      expect(h.events).toHaveBeenCalledWith("babysitter.install.finished", expect.objectContaining({ ok: false, exitCode: 3 }));
    } finally {
      vi.unstubAllEnvs();
      await h.runtime.inbox.close();
    }
  });

  it("retries transient host installation failures without new PR evidence", async () => {
    const f = await fixture(false, false, { gitWorkspace: true });
    await writeFile(join(f.checkout, "package.json"), "{}");
    const install = vi.spyOn(githubInstalls, "installGitHubPullRequestWorkspace")
      .mockRejectedValueOnce(new githubInstalls.GitHubWorkspaceInstallError(new Error("Registry temporarily unavailable.")))
      .mockResolvedValueOnce();
    try {
      await f.reconcile("babysitter.install.failed");
      const waiting = await f.runtime.inbox.get("acme/app", 12);
      expect(waiting?.status).toBe("waiting");
      expect(waiting?.wait?.retryAt).toEqual(expect.any(Number));
      expect(f.passes).toHaveLength(0);
      f.errors.mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(waiting!.wait!.retryAt! + 1);
      try { await f.reconcile(); }
      finally { now.mockRestore(); }
      expect(f.passes).toHaveLength(1);
    } finally { install.mockRestore(); await f.runtime.inbox.close(); }
  });

  it("parks a malformed lockfile without retrying unchanged installation inputs", async () => {
    const f = await fixture(false, false, { gitWorkspace: true });
    await writeFile(join(f.checkout, "package.json"), "{}");
    await writeFile(join(f.checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n---\nimporters: {}\n");
    try {
      await f.reconcile("babysitter.install.failed");
      const waiting = await f.runtime.inbox.get("acme/app", 12);
      expect(waiting?.status).toBe("waiting");
      expect(waiting?.wait).toMatchObject({ kind: "external", reason: expect.stringContaining("Source contains multiple documents") });
      expect(waiting?.wait?.retryAt).toBeUndefined();
      expect(f.passes).toHaveLength(0);
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_000);
      try { await f.reconcile("babysitter.install.failed"); }
      finally { now.mockRestore(); }
      expect(f.events.mock.calls.filter(([event]) => event === "babysitter.owner.started")).toHaveLength(1);
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
      await f.runtime.inbox.ingest("installer-fixed", "issue_comment", {
        action: "created", repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: {} },
        comment: { id: 99, body: "Installation inputs fixed. Please retry.", user: { login: "maintainer" } },
      });
      await writeFile(join(f.checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const install = vi.spyOn(githubInstalls, "installGitHubPullRequestWorkspace").mockResolvedValueOnce();
      try { await f.reconcile("babysitter.install.failed"); }
      finally { install.mockRestore(); }
      expect(f.passes).toHaveLength(1);
    } finally { await f.runtime.inbox.close(); }
  });

  it("preserves the Babysitter mention allowlist through Agent layer configuration", () => {
    const agent = defineAgent({ extends: babysitter, options: { mentionAllowlist: [" Stefina ", "other-user"] } });
    expect(getAgentLayerOptions(agent)).toMatchObject({ mentionAllowlist: [" Stefina ", "other-user"] });
    expect(agent.options.mentionAllowlist).toEqual([" Stefina ", "other-user"]);
  });

  it("publishes only normalized configured mention recipients to the repair worker", async () => {
    const configured = await fixture(false, false, { mentionAllowlist: [" Stefina ", "stefina", "other-user", "invalid login"] });
    try {
      await configured.reconcile();
      expect(configured.passes[0]?.tools).toContain("mentionOnPullRequest");
      expect(configured.passes[0]?.schemas.mentionOnPullRequest).toMatchObject({
        properties: { login: { enum: ["stefina", "other-user"] } },
      });
    } finally {
      await configured.runtime.inbox.close();
    }
  });

  it("retargets a stacked PR to the default branch after its parent merged there", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "main" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    try {
      await f.reconcile();
      const patch = f.command.mock.calls.find(([args]) => args.includes("PATCH"));
      expect(patch?.[0]).toEqual(expect.arrayContaining(["repos/acme/app/pulls/12", "base=main"]));
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps a stacked PR on its base while the parent is unmerged or landed elsewhere", async () => {
    const parents = [{ state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { ref: "feat/parent", repo: { owner: { login: "acme" } } }, base: { ref: "feat/grandparent" } }];
    const f = await fixture(false, false, { base: "feat/parent", parents });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH"))).toBe(false);
      expect(createProviderRuntime).toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("wakes a pushed head for a new failing check, not for its pending checks", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    try {
      await f.reconcile();
      f.choose(undefined);
      const head = f.pr().head.sha;
      const check = (id: number, status: string, conclusion: string | null) => f.runtime.inbox.ingest(`check-${id}-${status}`, "check_run", {
        repository: { full_name: "acme/app" }, action: status === "completed" ? "completed" : "created",
        check_run: { id, name: "test", head_sha: head, status, conclusion, app: { id: 1 }, pull_requests: [{ number: 12 }] },
      });
      await f.runtime.inbox.ingest("head-pushed", "pull_request", { repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr() });
      await check(2, "in_progress", null);
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      await check(2, "completed", "failure");
      f.reportCheckRun({ id: 2, name: "test", head_sha: head, status: "completed", conclusion: "failure", app: { id: 1 } });
      await f.reconcile();
      expect(f.passes).toHaveLength(2);
    } finally { await f.runtime.inbox.close(); }
  });

  it("ends a pass that keeps running after its repair push and parks on the pushed head", async () => {
    const f = await fixture(false, false, { postPushGraceMs: 10 });
    f.choose("pushRepair");
    const implementation = createProviderRuntime.getMockImplementation()!;
    createProviderRuntime.mockImplementation(async (...args: unknown[]) => {
      const runtime = await implementation(...args);
      const sendTurn = runtime.sendTurn;
      // After pushing, the worker keeps watching checks instead of returning.
      return { ...runtime, sendTurn: async (input: unknown) => { await sendTurn(input); return await new Promise(() => {}); } };
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      const state = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(state.status).toBe("waiting");
      expect(state.wait?.headSha).toBe("b".repeat(40));
      expect(state.lease).toBeNull();
    } finally { await f.runtime.inbox.close(); }
  });

  it("retries a provider rate limit, then blocks admission", async () => {
    const f = await fixture(false, false, { providerRetryDelayMs: 1 });
    createProviderRuntime.mockImplementation(async () => { throw new Error("429 Too Many Requests") });
    try {
      await f.reconcile().catch(() => {});
      expect(createProviderRuntime).toHaveBeenCalledTimes(4);
      expect(await f.runtime.inbox.metaNumber("provider-quota-blocked-until")).toBeGreaterThan(Date.now());
      await f.runtime.inbox.ingest("new-feedback", "issue_comment", { repository: { full_name: "acme/app" }, action: "created",
        issue: { number: 12, pull_request: {} }, comment: { id: 9, body: "Please fix", user: { login: "human", type: "User" } } });
      createProviderRuntime.mockClear();
      await f.reconcile().catch(() => {});
      expect(createProviderRuntime).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("leaves PRs queued while admission is refused and logs each pause reason once", async () => {
    let decision: { accepting: boolean; reason?: string; retryAt?: number; detail?: string } = { accepting: false, reason: "tmp-space-low", detail: "100 MiB free" };
    const f = await fixture(false, false, { admission: async () => decision });
    const skips = () => f.events.mock.calls.filter(([name]) => name === "babysitter.admission.skipped");
    try {
      await f.reconcile();
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(await f.runtime.inbox.get("acme/app", 12)).toBeUndefined();
      expect(skips()).toHaveLength(1);
      expect(await f.runtime.inbox.meta("admission-skipped")).toMatchObject({ reason: "tmp-space-low", detail: "100 MiB free" });
      decision = { accepting: false, reason: "token-budget-hourly", retryAt: Date.now() + 60_000 };
      await f.reconcile();
      expect(skips()).toHaveLength(2);
      expect(skips()[1]![1]).toMatchObject({ trigger: "test", reason: "token-budget-hourly" });
      decision = { accepting: true };
      await f.reconcile();
      expect(createProviderRuntime).toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("keeps host-only work running while model admission is paused", async () => {
    let decision: { accepting: boolean; hostOnly?: boolean; reason?: string } = { accepting: false, hostOnly: true, reason: "token-budget-hourly" };
    const f = await fixture(false, false, { admission: async () => decision, options: { reviewChecks: ["review-bot"] } });
    const finished = () => f.events.mock.calls.filter(([name]) => name === "babysitter.owner.finished").map(([, properties]) => properties.outcome);
    try {
      // A PR that needs a model pass is checked once, released unchanged and skipped until it changes.
      await f.reconcile();
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect(finished()).toEqual(["admission-paused"]);
      const released = await f.runtime.inbox.get("acme/app", 12);
      expect(released?.lease).toBeNull();
      expect(released?.status).toBe("ready");
      // New evidence makes it eligible for host-only work again: a running review check defers it without a model.
      const review = { id: 5, name: "review-bot", head_sha: f.pr().head.sha, status: "in_progress", conclusion: null, app: { id: 6 } };
      f.reportCheckRun(review);
      await f.runtime.inbox.ingest("review-started", "check_run", { repository: { full_name: "acme/app" }, action: "created", check_run: { ...review, pull_requests: [{ number: 12 }] } });
      await f.runtime.inbox.ingest("comment", "issue_comment", {
        repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: {} }, action: "created",
        comment: { id: 70, body: "Please also cover the empty case", user: { login: "developer", type: "User" } },
      });
      await f.reconcile();
      expect(createProviderRuntime).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.defer).toBe("checks");
      // A zero budget is an explicit pause: no claims at all.
      decision = { accepting: false, hostOnly: false, reason: "token-budget-hourly" };
      await f.runtime.inbox.ingest("comment-2", "issue_comment", {
        repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: {} }, action: "created",
        comment: { id: 71, body: "One more case", user: { login: "developer", type: "User" } },
      });
      const before = finished().length;
      await f.reconcile();
      expect(finished()).toHaveLength(before);
    } finally { await f.runtime.inbox.close(); }
  });

  it("never merges into a base other than the default branch", () => {
    const head = "a".repeat(40);
    const live = { state: "open", draft: false, mergeable_state: "clean", head: { sha: head }, base: { ref: "feat/parent", repo: { default_branch: "main" } } };
    expect(liveMergeReadiness(live, head)).toEqual({ ready: false, reason: "base feat/parent is not the default branch" });
    expect(liveMergeReadiness({ ...live, base: { ref: "main", repo: { default_branch: "main" } } }, head)).toEqual({ ready: true, head });
    expect(liveMergeReadiness({ ...live, base: { ref: "main", repo: { default_branch: "main" } } }, "b".repeat(40))).toMatchObject({ ready: false, reason: "head changed" });
  });

  it("selects the Claude Code driver", () => {
    const agent = defineAgent({ extends: babysitter, options: { driver: "claude-code" } });
    expect(getAgentLayerOptions(agent)?.driver).toMatchObject({ kind: "claude-code", permissions: "allow-edits-unattended" });
    expect(agent.options.driver).toBe("claude-code");
  });

  it.each([
    { config: { url: "https://agents.example.test" }, discovered: false },
    { config: { agents: { babysitter: "https://agents.example.test" } }, discovered: false },
    { config: { agents: { babysitter: "https://agents.example.test" } }, discovered: true },
  ])("links the session to the worker Agent invocation with %j", async ({ config, discovered }) => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", config);
    const createRun = vi.spyOn(githubRuns, "createGitHubPullRequestRun");
    const f = await fixture(false, discovered);
    try {
      await f.reconcile();
      expect(createRun).toHaveBeenCalledOnce();
      const options = createRun.mock.calls[0]![2];
      expect(options.agentName).toBe("babysitter-worker");
      const run = await createRun.mock.results[0]!.value;
      expect(run.activity?.links).toEqual([{
        label: "Current session",
        url: `https://agents.example.test/_vitehub/agents/babysitter-worker/invocations/${await agentInvocationId(options.runId, "babysitter-worker")}`,
      }]);
    } finally {
      await f.runtime.inbox.close();
      vi.unstubAllGlobals();
      createRun.mockRestore();
    }
  });

  it.each(["first-babysitter", "second-babysitter"])("scopes the repair worker to discovered Agent %s", async (agentName) => {
    const createRun = vi.spyOn(githubRuns, "createGitHubPullRequestRun");
    const f = await fixture(false, true, { agentName });
    try {
      await f.reconcile();
      expect(createRun).toHaveBeenCalledOnce();
      expect(createRun.mock.calls[0]![2].agentName).toBe(`${agentName}-worker`);
    } finally {
      await f.runtime.inbox.close();
      createRun.mockRestore();
    }
  });

  it("allows the metadata tool to clear the pull request body", async () => {
    const f = await fixture();
    f.choose("updatePullRequest", { body: "" });
    try {
      await f.reconcile();
      expect(f.command.mock.calls.some(([args]) => args.includes("PATCH") && args.includes("body="))).toBe(true);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["reclaimed", "expired"])("fences an admitted push when its lease is %s", async (loss) => {
    const f = await fixture();
    f.choose("pushRepair");
    f.onAdmission(() => {});
    let rejected = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      if (loss === "reclaimed") {
        await f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
        await f.runtime.inbox.claim(1);
      } else {
        vi.spyOn(Date, "now").mockReturnValue(current.leaseUntil);
      }
      try { await options?.beforePush?.(); }
      catch (error) { rejected = true; throw error; }
      return "b".repeat(40);
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      expect(f.push).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(rejected).toBe(true));
    } finally { vi.restoreAllMocks(); await f.runtime.inbox.close(); }
  });

  it("aborts an in-flight push when another owner reclaims the lease", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    let aborted = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      if (!options?.signal) throw new Error("Missing push cancellation signal");
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
      await f.runtime.inbox.claim(1);
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
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s when another owner reclaims during admission", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    let replacementToken: string | undefined;
    f.onAdmission(async () => {
      if (replacementToken) return;
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      await f.runtime.inbox.release({ token: current.lease!, generation: current.generation, snapshot: current });
      replacementToken = (await f.runtime.inbox.claim(1))[0]!.token;
    });
    try {
      await f.reconcile();
      expect(replacementToken).toBeDefined();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
      expect((await f.runtime.inbox.get("acme/app", 12))?.lease).toBe(replacementToken);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([
    ["commitRepair", "title"], ["commitRepair", "body"],
    ["pushRepair", "title"], ["pushRepair", "body"],
    ["commitRepair", "draft"], ["pushRepair", "draft"],
  ] as const)("fences %s after same-head PR %s requirements change", async (operation, field) => {
    const f = await fixture(true);
    f.choose(operation, operation === "commitRepair" ? { message: "repair value", paths: ["source.ts"] } : {});
    let edited = false;
    f.onAdmission(async () => {
      if (edited) return;
      edited = true;
      await f.runtime.inbox.ingest("metadata-edited", "pull_request", {
        repository: { full_name: "acme/app" },
        action: "edited",
        pull_request: { ...f.pr(), [field]: field === "draft" ? true : "Updated validation requirements." },
      });
    });
    try {
      await f.reconcile();
      expect(edited).toBe(true);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each((["successful check", "base advance", "failing check turns green", "failing status turns green"] as const).flatMap(change =>
    ([{ box: false, operation: "pushRepair" }, { box: true, operation: "pushRepair" }, { box: true, operation: "commitRepair" }] as const).map(configuration => ({ change, ...configuration })),
  ))("keeps $operation available after a same-head $change with Box=$box", async ({ change, box, operation }) => {
    const f = await fixture(true, false, { allowOperationAfterAdmission: true, box, remoteBox: box });
    f.choose(operation, operation === "commitRepair" ? { message: "Repair source", paths: ["source.ts"] } : {});
    let changed = false;
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const result = await command(args, request);
      if (!changed && change === "failing check turns green" && args.some(arg => arg.includes("/check-runs?"))) {
        return { ...result, stdout: result.stdout + "\n" + JSON.stringify({ id: 2, name: "repair-test", head_sha: f.pr().head.sha, status: "completed", conclusion: "failure", app: { id: 1 } }) };
      }
      if (!changed && change === "failing status turns green" && args.some(arg => arg.includes("/statuses?"))) {
        return { ...result, stdout: JSON.stringify({ context: "repair-test", sha: f.pr().head.sha, state: "failure" }) };
      }
      return result;
    });
    if (change === "failing check turns green" || change === "failing status turns green") {
      await f.runtime.inbox.seed("acme/app", f.pr());
      await f.runtime.inbox.ingest("initial-failure", change === "failing check turns green" ? "check_run" : "status", {
        repository: { full_name: "acme/app" }, action: "completed",
        ...(change === "failing check turns green" ? { check_run: { id: 2, name: "repair-test", head_sha: f.pr().head.sha, status: "completed", conclusion: "failure", app: { id: 1 }, pull_requests: [{ number: 12 }] } }
          : { context: "repair-test", sha: f.pr().head.sha, state: "failure" }),
      });
    }
    f.onRepair(async () => {
      if (changed) return;
      const before = await f.runtime.inbox.get("acme/app", 12);
      if (!before?.lease) throw new Error("The provider must own an active claim before the evidence changes.");
      expect(f.passes).toHaveLength(1);
      changed = true;
      if (change === "base advance") {
        f.advanceBase("d".repeat(40));
        await f.runtime.inbox.ingest("base-advanced", "pull_request", {
          repository: { full_name: "acme/app" }, action: "edited", pull_request: f.pr(),
        });
      } else if (change === "failing status turns green") {
        await f.runtime.inbox.ingest("status-succeeded", "status", {
          repository: { full_name: "acme/app" }, context: "repair-test", sha: f.pr().head.sha, state: "success",
        });
      } else {
        await f.runtime.inbox.ingest("check-succeeded", "check_run", {
          repository: { full_name: "acme/app" }, action: "completed",
          check_run: { id: 2, name: change === "failing check turns green" ? "repair-test" : "test", head_sha: f.pr().head.sha,
          status: "completed", conclusion: "success", app: { id: 1 }, pull_requests: [{ number: 12 }] },
        });
      }
      expect((await f.runtime.inbox.get("acme/app", 12))?.generation).toBeGreaterThan(before.generation);
    });
    try {
      await f.reconcile();
      expect(changed).toBe(true);
      expect(operation === "commitRepair" ? f.commit : f.push).toHaveBeenCalledOnce();
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["commitRepair", "pushRepair"] as const)("fences %s when an existing review thread is reopened", async operation => {
    const f = await fixture(true);
    f.choose(operation, operation === "commitRepair" ? { message: "repair value", paths: ["source.ts"] } : {});
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => args.some(arg => arg.includes("reviewThreads"))
      ? { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: "PRRT_1", isResolved: true, comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }), stderr: "" } : await command(args, request));
    let reopened = false;
    f.onAdmission(async () => {
      if (reopened) return;
      reopened = true;
      await f.runtime.inbox.ingest("thread-reopened", "pull_request_review_thread", {
        repository: { full_name: "acme/app" }, action: "unresolved", pull_request: f.pr(),
        thread: { node_id: "PRRT_1", comments: [] },
      });
    });
    try {
      await f.reconcile();
      expect(reopened).toBe(true);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("still fences merge authorization after same-head metadata changes", async () => {
    const f = await fixture(true);
    f.choose("requestAutoMerge");
    let edited = false;
    f.onAdmission(async () => {
      if (edited) return;
      edited = true;
      await f.runtime.inbox.ingest("metadata-edited", "pull_request", {
        repository: { full_name: "acme/app" }, action: "edited",
        pull_request: { ...f.pr(), body: "Updated merge requirements." },
      });
    });
    try {
      await f.reconcile();
      expect(edited).toBe(true);
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["commitRepair", "pushRepair"] as const)("fences %s when the source branch is renamed on the same head", async operation => {
    const f = await fixture(true);
    f.choose(operation, operation === "commitRepair" ? { message: "repair value", paths: ["source.ts"] } : {});
    f.onAdmission(() => {});
    f.onRepair(async () => {
      await f.runtime.inbox.ingest("source-renamed", "pull_request", {
        repository: { full_name: "acme/app" }, action: "edited",
        pull_request: { ...f.pr(), head: { ...f.pr().head, ref: "renamed" } },
      });
    });
    try {
      await f.reconcile();
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
    } finally { await f.runtime.inbox.close(); }
  });

  it("renews a slow repair push against a validated same-head base advance", async () => {
    const f = await fixture(true, false, { allowOperationAfterAdmission: true });
    f.choose("pushRepair");
    let changed = false;
    f.onAdmission(async () => {
      if (changed) return;
      changed = true;
      await f.runtime.inbox.ingest("metadata-edited", "pull_request", {
        repository: { full_name: "acme/app" }, action: "edited",
        pull_request: { ...f.pr(), base: { ...f.pr().base, sha: "d".repeat(40) } },
      });
    });
    const timers = vi.spyOn(globalThis, "setInterval");
    const renew = vi.spyOn(f.runtime.inbox, "renew");
    const originalPush = f.push.getMockImplementation()!;
    f.push.mockImplementationOnce(async (...args) => {
      const renewal = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!renewal) throw new Error("Missing push renewal timer");
      renewal();
      await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
      expect(await renew.mock.results[0]?.value).toBe(true);
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(renew.mock.calls[0]?.[0].generation).toBe(current.generation);
      return await originalPush(...args);
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
    } finally {
      timers.mockRestore();
      renew.mockRestore();
      await f.runtime.inbox.close();
    }
  });

  it("keeps an in-flight renewal alive after a push while the head webhook is pending", async () => {
    const f = await fixture(true, false, { allowOperationAfterAdmission: true });
    f.choose("pushRepair");
    const timers = vi.spyOn(globalThis, "setInterval");
    const getOriginal = f.runtime.inbox.get.bind(f.runtime.inbox);
    const get = vi.spyOn(f.runtime.inbox, "get");
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const renew = vi.spyOn(f.runtime.inbox, "renew");
    let completed = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      get.mockImplementationOnce(async (...args) => { entered(); await blocked; return await getOriginal(...args); });
      const renewal = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!renewal) throw new Error("Missing push renewal timer");
      renewal();
      await started;
      await options?.afterPush?.("b".repeat(40));
      release();
      await vi.waitFor(() => {
        if (options?.signal?.aborted) throw options.signal.reason;
        expect(renew).toHaveBeenCalledOnce();
      });
      expect(await renew.mock.results[0]?.value).toBe(true);
      completed = true;
      return "b".repeat(40);
    });
    try {
      await f.reconcile();
      expect(completed).toBe(true);
    } finally { release?.(); timers.mockRestore(); get.mockRestore(); renew.mockRestore(); await f.runtime.inbox.close(); }
  });

  it.each([{ published: false, lateOwn: false, rollback: false }, { published: true, lateOwn: false, rollback: false }, { published: true, lateOwn: true, rollback: false }, { published: true, lateOwn: false, rollback: true }])("fences source pushes before synchronize, published=$published lateOwn=$lateOwn rollback=$rollback", async ({ published, lateOwn, rollback }) => {
    const f = await fixture();
    f.choose("pushRepair");
    f.onAdmission(() => {});
    const timers = vi.spyOn(globalThis, "setInterval");
    const renew = vi.spyOn(f.runtime.inbox, "renew");
    let rejected = false;
    const otherHead = rollback ? f.pr().head.sha : "c".repeat(40);
    f.push.mockImplementationOnce(async (_target, options) => {
      if (published) await options?.afterPush?.("b".repeat(40));
      await f.runtime.inbox.ingest("other-source-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: otherHead,
      });
      expect((await f.runtime.inbox.get("acme/app", 12))?.sourcePushHead).toBe(otherHead);
      if (lateOwn) await f.runtime.inbox.ingest("delayed-own-source-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: "b".repeat(40),
      });
      const renewal = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!renewal) throw new Error("Missing push renewal timer");
      renewal();
      await vi.waitFor(() => expect(options?.signal?.aborted).toBe(true));
      rejected = true;
      options?.signal?.throwIfAborted();
      return "b".repeat(40);
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(rejected).toBe(true));
      expect(renew).not.toHaveBeenCalled();
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(current.status).toBe("ready");
      expect(current.wait).toBeUndefined();
    } finally { timers.mockRestore(); renew.mockRestore(); await f.runtime.inbox.close(); }
  });

  it.each([ ["check", false], ["status", false], ["check", true], ["status", true] ] as const)("fences a failed %s for an owned push before synchronize, CI first=%s", async (evidence, ciFirst) => {
    const f = await fixture(false, false, { operationCount: 2, expectedOperationErrorAt: 1 });
    f.choose("pushRepair");
    const head = "b".repeat(40);
    f.push.mockImplementationOnce(async (_target, options) => {
      await options?.beforePush?.(head);
      if (!ciFirst) await f.runtime.inbox.ingest("early-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: head,
      });
      if (evidence === "check") await f.runtime.inbox.ingest("early-failure", "check_run", {
        repository: { full_name: "acme/app" }, check_run: { id: 99, name: "new failure", head_sha: head, status: "completed", conclusion: "failure", pull_requests: [{ number: 12 }] },
      });
      else await f.runtime.inbox.ingest("early-failure", "status", {
        repository: { full_name: "acme/app" }, sha: head, context: "new failure", state: "failure",
      });
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(evidence === "check" ? current.checks["check_run:99"]?.conclusion : current.statuses["new failure"]?.state).toBe("failure");
      if (ciFirst) await f.runtime.inbox.ingest("late-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: head,
      });
      f.advanceHead(head);
      await f.runtime.inbox.ingest("late-synchronize", "pull_request", {
        repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr(),
      });
      await expect(options?.afterPush?.(head)).rejects.toThrow("evidence changed");
      return head;
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.headSha).toBe(head);
    } finally { await f.runtime.inbox.close(); }
  });

  it("parks all verified repair pushes when retry admission closes", async () => {
    let accepting = true;
    const retryAt = Date.now() + 300_000;
    const admission = async () => ({ accepting, retryAt, accounting: "best-effort-retained-journal" as const, hostOnly: true,
      reason: "token-budget-hourly" as const, limits: resolveBabysitterAdmissionLimits(),
      state: { windows: babysitterBudgetWindows(Date.now()), tmpDir: "/tmp" } });
    const f = await fixture(false, false, { box: true, admission, operationCount: 2, providerRetryDelayMs: 1 });
    f.choose("pushRepair");
    let count = 0;
    f.push.mockImplementation(async (_target, options) => {
      const head = (++count === 1 ? "b" : "d").repeat(40);
      f.advanceHead(head);
      await options?.afterPush?.(head);
      await f.runtime.inbox.ingest(`owned-push-${count}`, "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: head,
      });
      return head;
    });
    const implementation = createProviderRuntime.getMockImplementation()!;
    createProviderRuntime.mockImplementation(async (...args: unknown[]) => {
      const runtime = await implementation(...args);
      const sendTurn = runtime.sendTurn;
      return { ...runtime, sendTurn: async (input: unknown) => {
        await sendTurn(input); accepting = false; throw new Error("429 Too Many Requests");
      } };
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledTimes(2);
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(current.status).toBe("waiting");
      expect(current.wait?.headSha).toBe("d".repeat(40));
      expect(current.wait?.retryAt).toBe(retryAt);
      expect(current.lastResult).toContain("host admission");
      expect(createProviderRuntime).toHaveBeenCalledOnce();
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([false, true])("records a verified thread resolution without a webhook, already resolved=%s", async alreadyResolved => {
    const head = "a".repeat(40);
    const f = await fixture(false, false, { result: { disposition: "park", text: "Reviewed this head.", reviewedHead: head,
      wait: { kind: "checks", headSha: head } } });
    f.choose("resolveReviewThread", { id: "PRRT_1" });
    let resolved = alreadyResolved;
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const query = args.join(" ");
      if (query.includes("reviewThreads")) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: "PRRT_1", isResolved: false, comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }), stderr: "" };
      if (query.includes("node(id:")) return { stdout: JSON.stringify({ data: { node: { pullRequest: { id: "PR_12" }, isResolved: resolved } } }), stderr: "" };
      if (query.includes("resolveReviewThread(input:")) {
        resolved = true;
        return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1" } } } }), stderr: "" };
      }
      return await command(args, request);
    });
    try {
      await f.reconcile();
      const current = await f.runtime.inbox.get("acme/app", 12);
      expect(current?.threads[0]?.isResolved).toBe(true);
      expect(current?.status).toBe("waiting");
      expect(current?.lastResult).toBe("Reviewed this head.");
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([false, true])("keeps owned thread resolutions while fencing external reopens=%s", async reopen => {
    const f = await fixture(false, false, { operationCount: 2, operationInputs: [{ id: "PRRT_1" }, { id: "PRRT_2" }],
      ...(reopen ? { expectedOperationErrorAt: 1 } : {}) });
    f.choose("resolveReviewThread");
    const resolved = new Set<string>();
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const query = args.join(" ");
      if (query.includes("reviewThreads")) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: ["PRRT_1", "PRRT_2"].map(id => ({ id, isResolved: resolved.has(id), comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }), stderr: "" };
      if (query.includes("node(id:")) return { stdout: JSON.stringify({ data: { node: { pullRequest: { id: "PR_12" }, isResolved: false } } }), stderr: "" };
      if (query.includes("resolveReviewThread(input:")) {
        const id = args.find(arg => arg.startsWith("id="))!.slice(3);
        resolved.add(id);
        await f.runtime.inbox.ingest(`owned-resolve-${id}`, "pull_request_review_thread", {
          repository: { full_name: "acme/app" }, action: "resolved", pull_request: f.pr(), thread: { node_id: id, comments: [] },
        });
        if (reopen && id === "PRRT_1") await f.runtime.inbox.ingest("external-reopen", "pull_request_review_thread", {
          repository: { full_name: "acme/app" }, action: "unresolved", pull_request: f.pr(), thread: { node_id: id, comments: [] },
        });
        return { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id } } } }), stderr: "" };
      }
      return await command(args, request);
    });
    try {
      await f.reconcile();
      expect([...resolved]).toEqual(reopen ? ["PRRT_1"] : ["PRRT_1", "PRRT_2"]);
    } finally { await f.runtime.inbox.close(); }
  });

  it("retains an accepted worker push before the local push command returns", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    const head = "b".repeat(40);
    const timers = vi.spyOn(globalThis, "setInterval");
    const renew = vi.spyOn(f.runtime.inbox, "renew");
    let completed = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      await options?.beforePush?.(head);
      f.advanceHead(head);
      await f.runtime.inbox.ingest("early-own-source-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: head,
      });
      const renewal = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!renewal) throw new Error("Missing push renewal timer");
      renewal();
      await vi.waitFor(() => {
        options?.signal?.throwIfAborted();
        expect(renew).toHaveBeenCalledOnce();
      });
      expect(await renew.mock.results[0]?.value).toBe(true);
      await options?.afterPush?.(head);
      completed = true;
      return head;
    });
    try {
      await f.reconcile();
      expect(completed).toBe(true);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.headSha).toBe(head);
    } finally { timers.mockRestore(); renew.mockRestore(); await f.runtime.inbox.close(); }
  });

  it.each(["comment", "failed check"])("rechecks %s before publication after successive verified pushes", async feedback => {
    const f = await fixture(false, false, { operationCount: 3, expectedOperationErrorAt: 2 });
    f.choose("pushRepair");
    const first = "b".repeat(40), second = "d".repeat(40);
    f.push.mockImplementationOnce(async (_target, options) => {
      f.advanceHead(first);
      await options?.afterPush?.(first);
      await f.runtime.inbox.ingest("first-head-synchronized", "pull_request", {
        repository: { full_name: "acme/app" }, action: "synchronize", pull_request: f.pr(),
      });
      return first;
    });
    f.push.mockImplementationOnce(async (_target, options) => {
      f.advanceHead(second);
      await options?.afterPush?.(second);
      if (feedback === "comment") await f.runtime.inbox.ingest("new-requirement", "issue_comment", {
        repository: { full_name: "acme/app" }, action: "created", issue: { number: 12, pull_request: {} },
        comment: { id: 99, body: "Preserve the existing API contract.", user: { login: "reviewer" } },
      });
      else await f.runtime.inbox.ingest("new-failure", "check_run", {
        repository: { full_name: "acme/app" }, check_run: { id: 99, name: "new requirement", head_sha: first, status: "completed", conclusion: "failure", pull_requests: [{ number: 12 }] },
      });
      return second;
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledTimes(2);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.headSha).toBe(second);
    } finally { await f.runtime.inbox.close(); }
  });

  it("revalidates an equivalent generation arriving between renewal read and CAS", async () => {
    const f = await fixture(true, false, { allowOperationAfterAdmission: true });
    f.choose("pushRepair");
    const timers = vi.spyOn(globalThis, "setInterval");
    const originalRenew = f.runtime.inbox.renew.bind(f.runtime.inbox);
    const renew = vi.spyOn(f.runtime.inbox, "renew");
    renew.mockImplementationOnce(async (...args) => {
      await f.runtime.inbox.ingest("renewal-metadata-edited", "pull_request", {
        repository: { full_name: "acme/app" }, action: "edited",
        pull_request: { ...f.pr(), base: { ...f.pr().base, sha: "d".repeat(40) } },
      });
      return await originalRenew(...args);
    });
    const originalPush = f.push.getMockImplementation()!;
    let completed = false;
    f.push.mockImplementationOnce(async (...args) => {
      const renewal = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!renewal) throw new Error("Missing push renewal timer");
      renewal();
      await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(2));
      expect(await renew.mock.results[1]?.value).toBe(true);
      args[1]?.signal?.throwIfAborted();
      completed = true;
      return await originalPush(...args);
    });
    try {
      await f.reconcile();
      expect(completed).toBe(true);
    } finally {
      timers.mockRestore();
      renew.mockRestore();
      await f.runtime.inbox.close();
    }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s when feedback advances the claimed generation during admission", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    let generation: number | undefined;
    f.onAdmission(async () => {
      if (generation !== undefined) return;
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      generation = current.generation;
      await f.runtime.inbox.ingest("new-inline-feedback", "pull_request_review_comment", {
        repository: { full_name: "acme/app" },
        action: "created",
        pull_request: f.pr(),
        comment: { id: 99, body: "Fix this regression before merging.", user: { login: "reviewer", type: "User" } },
      });
      const updated = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(updated.generation).toBeGreaterThan(generation);
      expect(updated.lease).toBe(current.lease);
    });
    try {
      await f.reconcile();
      expect(generation).toBeDefined();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      expect(current.handled).toBeLessThan(current.generation);
      expect(current.status).toBe("ready");
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["pushRepair", "requestAutoMerge"] as const)("fences %s after lease expiry without waiting for recovery", async (operation) => {
    const f = await fixture(true);
    f.choose(operation);
    f.onAdmission(async () => {
      const current = (await f.runtime.inbox.get("acme/app", 12))!;
      vi.spyOn(Date, "now").mockReturnValue(current.leaseUntil);
    });
    try {
      await f.reconcile();
      expect(f.push).not.toHaveBeenCalled();
      expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await f.runtime.inbox.close();
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
    const state = (await f.runtime.inbox.get("acme/app", 12))!;
    expect(state.status).toBe("waiting");
    expect(state.handled).toBe(state.generation);
    expect(state.attempts).toBe(0);
    expect(state.wait?.headSha).toBe("b".repeat(40));
    // The synchronize event for the repair's own push keeps the wait.
    await f.runtime.inbox.ingest("head-pushed", "pull_request", {
      repository: { full_name: "acme/app" },
      action: "synchronize",
      pull_request: f.pr(),
    });
    expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("waiting");
  });

  it("retries checkout failure when no repair was pushed", async () => {
    const f = await fixture();
    f.failCheckout(new Error("Checkout cleanup failed"));
    await f.reconcile();
    expect(f.push).not.toHaveBeenCalled();
    const state = (await f.runtime.inbox.get("acme/app", 12))!;
    expect(state.status).toBe("ready");
    expect(state.handled).toBeLessThan(state.generation);
    expect(state.attempts).toBe(1);
  });


  it("pushes the committed remote Box HEAD while the provider and Box remain active", async () => {
    const f = await fixture(false, false, { box: true, remoteBox: true });
    f.choose("pushRepair");
    await f.reconcile();
    expect(f.push).toHaveBeenCalledOnce();
  });

  it("commits uncommitted remote Box edits through the protected host repair index", async () => {
    const f = await fixture(false, false, { box: true, remoteBox: true });
    f.choose("commitRepair", { message: "Repair source", paths: ["source.ts"] });
    await f.reconcile();
    expect(f.commit).toHaveBeenCalledOnce();
    const committed = await promisify(execFile)("git", ["-C", f.checkout, "show", "HEAD:source.ts"]);
    expect(committed.stdout).toBe("export const value = 2\n");
  });

  it.each([false, true])("prepares the live target branch when the PR base snapshot is stale (Box: %s)", async box => {
    const baseBranchHead = "e".repeat(40);
    const f = await fixture(false, false, { box, mergeableState: "dirty", baseBranchHead });
    try {
      await f.reconcile();
      expect(f.pr().base.sha).not.toBe(baseBranchHead);
      expect(f.passes).toHaveLength(1);
      expect(prepareGitHubRepairBase).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expectedHead: f.pr().head.sha, base: baseBranchHead, fetch: { url: "https://github.com/acme/app.git", env: expect.objectContaining({ GH_TOKEN: "host-secret" }) } }));
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([
    [false, "readBaseCheckEvidence"], [true, "readBaseCheckEvidence"],
    [false, "readBaseCheckLogs"], [true, "readBaseCheckLogs"],
  ] as const)("pins %s conflict repair CI tools to the prepared live base through %s", async (box, operation) => {
    const liveBase = "e".repeat(40);
    const f = await fixture(false, false, { box, mergeableState: "dirty", baseBranchHead: liveBase });
    const staleBase = f.pr().base.sha;
    vi.mocked(prepareGitHubRepairBase).mockImplementationOnce(async () => { f.advanceBase(liveBase); });
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, request) => {
      const path = args.find(arg => arg.startsWith("/repos/"));
      if (path === `/repos/acme/app/commits/${liveBase}/check-runs?per_page=100`)
        return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }), stderr: "" };
      if (path === `/repos/acme/app/commits/${liveBase}/statuses?per_page=100`)
        return { stdout: "[]", stderr: "" };
      if (path === `/repos/acme/app/actions/runs?head_sha=${liveBase}&per_page=100`)
        return { stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }), stderr: "" };
      if (path === "/repos/acme/app/actions/runs/42")
        return { stdout: JSON.stringify({ head_sha: liveBase, repository: { full_name: "acme/app" } }), stderr: "" };
      if (args[0] === "run" && args[1] === "view") return { stdout: "base failure logs", stderr: "" };
      return await command(args, request);
    });
    f.choose(operation, operation === "readBaseCheckLogs" ? { runId: 42 } : {});
    try {
      await f.reconcile();
      expect(staleBase).not.toBe(liveBase);
      expect(f.passes).toHaveLength(1);
      expect(f.command.mock.calls.some(([args]) => args.some(arg => operation === "readBaseCheckEvidence"
        ? arg.includes(`/commits/${liveBase}/check-runs`)
        : arg === "/repos/acme/app/actions/runs/42"))).toBe(true);
      expect(f.command.mock.calls.some(([args]) => args.some(arg => arg.includes(`/commits/${staleBase}/`)))).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it.each(["commitRepair", "pushRepair"] as const)("rejects %s when the live base moves but the PR snapshot stays stale", async operation => {
    const settings = { mergeableState: "dirty", baseBranchHead: "e".repeat(40) };
    const f = await fixture(false, false, settings);
    const staleBase = f.pr().base.sha;
    f.choose(operation, operation === "commitRepair" ? { message: "resolve base conflict", paths: ["source.ts"] } : {});
    f.onAdmission(() => { settings.baseBranchHead = "f".repeat(40); });
    try {
      await f.reconcile();
      expect(f.passes).toHaveLength(1);
      expect(f.pr().base.sha).toBe(staleBase);
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.push).not.toHaveBeenCalled();
      expect((await f.runtime.inbox.get("acme/app", 12))?.status).toBe("ready");
    } finally { await f.runtime.inbox.close(); }
  });

  it.each([false, true])("retains the publication chain while synchronize webhooks lag, first observed=%s", async observed => {
    const f = await fixture(false, false, { operationCount: 2 });
    f.choose("pushRepair");
    const first = "b".repeat(40), second = "d".repeat(40);
    const originalPush = f.push.getMockImplementation()!;
    let completed = false;
    f.push.mockImplementationOnce(async (_target, options) => {
      await originalPush(_target, options);
      await options?.afterPush?.(first);
      await f.runtime.inbox.ingest("first-repair-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: first,
      });
      if (observed) await f.runtime.inbox.ingest("first-repair-synchronize", "pull_request", {
        repository: { full_name: "acme/app" }, action: "synchronize",
        pull_request: { ...f.pr(), head: { ...f.pr().head, sha: first } },
      });
      return first;
    });
    f.push.mockImplementationOnce(async (_target, options) => {
      await options?.afterPush?.(second);
      await f.runtime.inbox.ingest("second-repair-push", "push", {
        repository: { full_name: "acme/app" }, ref: `refs/heads/${f.pr().head.ref}`, after: second,
      });
      options?.signal?.throwIfAborted();
      completed = true;
      return second;
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledTimes(2);
      expect(completed).toBe(true);
      expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.headSha).toBe(second);
    } finally { await f.runtime.inbox.close(); }
  });

  it("records repair publication when the live base advances after the remote push", async () => {
    const settings = { mergeableState: "dirty", baseBranchHead: "e".repeat(40) };
    const f = await fixture(false, false, settings);
    f.choose("pushRepair");
    const originalPush = f.push.getMockImplementation()!;
    f.push.mockImplementationOnce(async (...args) => {
      await args[1]?.beforePush?.();
      const head = await originalPush(...args);
      settings.baseBranchHead = "f".repeat(40);
      if (args[1]?.afterPush) await args[1].afterPush(head);
      else await args[1]?.beforePush?.();
      return head;
    });
    try {
      await f.reconcile();
      const stored = await f.runtime.inbox.get("acme/app", 12);
      expect(f.push).toHaveBeenCalledOnce();
      expect(stored?.status).toBe("waiting");
      expect(stored?.wait?.headSha).toBe("b".repeat(40));
    } finally { await f.runtime.inbox.close(); }
  });

  it("rejects a live base move at the push boundary before mutating the remote", async () => {
    const settings = { mergeableState: "dirty", baseBranchHead: "e".repeat(40) };
    const f = await fixture(false, false, settings);
    f.choose("pushRepair");
    const originalPush = f.push.getMockImplementation()!;
    let remoteMutated = false;
    f.push.mockImplementationOnce(async (...args) => {
      settings.baseBranchHead = "f".repeat(40);
      await args[1]?.beforePush?.();
      remoteMutated = true;
      return await originalPush(...args);
    });
    try {
      await f.reconcile();
      expect(f.push).toHaveBeenCalledOnce();
      expect(remoteMutated).toBe(false);
    } finally { await f.runtime.inbox.close(); }
  });

  it("prepares the exact conflict base and frozen dependencies before opening a Box", async () => {
    const f = await fixture(false, false, { box: true, mergeableState: "dirty" });
    const install = vi.spyOn(githubInstalls, "installGitHubPullRequestWorkspace").mockImplementation(async directory => {
      expect(f.prepare).not.toHaveBeenCalled();
      expect(boxDefinitions).not.toHaveBeenCalled();
      await writeFile(join(directory, "dependencies.ready"), "installed\n");
    });
    try {
      await f.reconcile();
      expect(prepareGitHubRepairBase).toHaveBeenCalledWith(f.checkout, expect.objectContaining({ expectedHead: f.pr().head.sha, base: f.pr().base.sha }));
      expect(install).toHaveBeenCalledOnce();
      expect(await readFile(join(f.checkout, "dependencies.ready"), "utf8")).toBe("installed\n");
      expect(f.passes).toHaveLength(1);
    } finally { install.mockRestore(); }
  });

  it.each([false, true])("repairs through a trusted-host Box using the prepared PR working tree (inherited checkout: %s)", async (boxCheckout) => {
    const f = await fixture(false, false, { box: true, boxCheckout });
    f.choose("pushRepair");
    await f.reconcile();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(boxDefinitions).toHaveBeenCalledWith(expect.objectContaining({ requires: ["sh", "git"] }));
    expect(f.push.mock.calls[0]?.[0]).toBe(f.checkout);
    expect(f.passes).toHaveLength(1);
  });

  it("repairs through broker tools, parks without polling, and resumes on new evidence with merge disabled", async () => {
    const f = await fixture();
    f.choose("pushRepair");
    await f.reconcile();
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.passes[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(f.passes[0]?.approvalPolicy).toBe("never");
    expect(f.passes[0]?.tools).not.toContain("requestAutoMerge");
    expect(f.passes[0]?.tools).toContain("internalCheck");
    expect(f.passes[0]?.prompt).toContain("new-review-bot[bot]");
    expect(f.passes[0]?.instructions).toContain("Preserve the documented API contract.");
    expect(f.passes[0]?.instructions).toContain("Use hosted CI for full typechecks");
    expect(f.passes[0]?.instructions).toContain("stop after a memory-limit failure");
    expect(f.passes[0]?.instructions).not.toContain("{{{ instructions }}}");
    // An open thread disables the wait, so the pass resolves fixed threads before it parks.
    expect(f.passes[0]?.instructions).toContain("After pushing, resolve the review threads that push fixes, then stop");
    expect(f.passes[0]?.descriptions.pushRepair).toContain("resolve any review threads fixed by the push before ending the pass");
    const environment = createProviderRuntime.mock.calls[0]?.[0].environment;
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("VITEHUB_GITHUB_HEAD_TOKEN");
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
    // The repair's own push and its pending checks do not start another pass.
    await f.runtime.inbox.ingest("head-pushed", "pull_request", {
      repository: { full_name: "acme/app" },
      action: "synchronize",
      pull_request: f.pr(),
    });
    await f.runtime.inbox.ingest("check-pending", "check_run", {
      repository: { full_name: "acme/app" }, action: "created",
      check_run: { id: 2, name: "test", head_sha: f.pr().head.sha, status: "in_progress", conclusion: null, app: { id: 1 }, pull_requests: [{ number: 12 }] },
    });
    await f.reconcile();
    expect(f.passes).toHaveLength(1);
    await f.runtime.inbox.ingest("new-feedback", "pull_request_review", {
      repository: { full_name: "acme/app" }, action: "submitted", pull_request: f.pr(),
      review: { id: 42, body: "Check this follow-up", user: { login: "another-bot[bot]", type: "Bot" }, state: "COMMENTED", commit_id: f.pr().head.sha },
    });
    // The required check still runs, so the pass waits and later handles its result with the feedback.
    await f.reconcile();
    expect(f.passes).toHaveLength(1);
    expect((await f.runtime.inbox.get("acme/app", 12))?.wait?.defer).toBe("checks");
    f.reportCheckRun({ id: 3, name: "test", head_sha: f.pr().head.sha, status: "completed", conclusion: "success" });
    await f.runtime.inbox.ingest("check-passed", "check_run", {
      repository: { full_name: "acme/app" }, action: "completed",
      check_run: { id: 3, name: "test", head_sha: f.pr().head.sha, status: "completed", conclusion: "success", pull_requests: [{ number: 12 }] },
    });
    await f.reconcile();
    expect(f.passes).toHaveLength(2);
    expect(new Set(f.passes.map(pass => pass.session)).size).toBe(2);
    expect(f.runtime.workload()).toEqual({ running: 0 });
    await f.runtime.inbox.close();
  });

  it("cancels host operations when the checkout is revoked", async () => {
    const f = await fixture(true);
    f.choose("requestAutoMerge");
    f.abortOnOperation();
    await f.reconcile();
    expect(f.command.mock.calls.some(([args]) => args.join(" ").includes("enablePullRequestAutoMerge"))).toBe(false);
    expect(f.runtime.workload()).toEqual({ running: 0 });
    await f.runtime.inbox.close();
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
    await f.runtime.inbox.close();
  });
  it("keeps queue reconciliation available while a saved status is being published", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(false, false, { activityBarrier: barrier });
    await f.reconcile();
    expect(await f.runtime.inbox.pendingStatusDeliveries()).toHaveLength(1);
    const tracked: Promise<unknown>[] = [];
    const second = f.runtime.reconcile("test", { track: work => { tracked.push(work); return work; } });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([second, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Status publication blocked reconciliation.")), 1_000);
      })]);
      expect(tracked.length).toBeGreaterThan(0);
      let settled = false;
      const publication = Promise.all(tracked).then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      release();
      await publication;
    } finally {
      clearTimeout(deadline);
      release();
      await second;
      await Promise.all(tracked);
      await vi.waitFor(async () => expect(await f.runtime.inbox.metaEntries("status-outbox:v1:")).toHaveLength(0));
      await f.runtime.inbox.close();
    }
  });

});
