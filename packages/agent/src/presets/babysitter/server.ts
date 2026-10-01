import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { resolvePublicUrl, resolveRuntimeValue } from "@vite-hub/runtime";
import { hasRuntimeType } from "../../internal/runtime-type.ts";
import type { ProcessReconcilerRunContext } from "@vite-hub/runtime/node";
import { createMessage, defineAgent, runAgent } from "../../index.ts";
import type { AgentInput, ClaudeCodeDriverOptions, CodexDriverOptions } from "../../index.ts";
import {
  createGitHubPullRequestRun,
  createGitHubPullRequestOperations,
} from "../../server/github.ts";
import type { GitHubHost } from "../../server/github.ts";
import {
  PullRequestInbox,
  normalizePullRequest,
  snapshotPrompt,
  assertPromptFits,
  snapshotPullRequest,
  createClaimStopCheck,
  hydrateSnapshot,
  reconcileOneSnapshot,
  readPullRequestThreads,
} from "../../server/github-inbox.ts";
import type { Claim, PullRequestInboxStorage, Snapshot } from "../../server/github-inbox.ts";
import { babysitterPassResultSchema } from "../babysitter.ts";
import type { BabysitterAgent, BabysitterPassResult } from "../babysitter.ts";
import { getAgentLayerOptions } from "../../agent-layers.ts";
import { repairCapability, repairEnvironment } from "./repair.ts";
import { createGitHubRequiredCheckPolicyReader, evaluateGitHubRequiredChecks } from "../../server/github-required-checks.ts";
import { directMergeReadiness, liveMergeReadiness, resolveBabysitterMerge, snapshotCheckEvidence } from "./merge.ts";
import { createCheckWait, isExternalWaitResult, shouldKeepWaiting, type BabysitterWaitPolicy } from "./wait.ts";
import { nonDefaultBase, stackRetargetBase } from "./stack.ts";

export interface BabysitterRuntimeOptions {
  agent: AgentInput;
  /** Discovered Agent name for per-Agent public URLs. Defaults to the definition name. */
  agentName?: string;
  github: GitHubHost;
  /** Private `node:sqlite` inbox file. Set this or `inboxStorage`. */
  inboxPath?: string;
  /** Inbox tables in shared SQL storage, for example `agentState.extension("babysitter")`. */
  inboxStorage?: PullRequestInboxStorage;
  repositories: string[];
  concurrency: number;
  /** Public Console origin. Defaults to `vitehub({ publicUrl })`. */
  publicUrl?: string;
  event?: (name: string, properties: Record<string, unknown>) => void;
  error?: (name: string, error: unknown, properties: Record<string, unknown>) => void;
  wake?: () => void;
  /** GitHub logins whose marked comments are emitted by this host. */
  activityAuthors: readonly string[];
  /** How long a pass may continue after a repair push. Defaults to 3 minutes. */
  postPushGraceMs?: number;
  /** Delay between provider rate-limit retries. Defaults to 10 seconds. */
  providerRetryDelayMs?: number;
}

/** Provider quota and rate-limit failures. Cancellation is never a rate limit. */
export function isProviderRateLimit(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const text = error instanceof Error ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? "")}` : String(error);
  return /\b429\b|too many requests|rate limit/i.test(text);
}

/** Own one durable PR inbox and its repair passes inside a process host. */
export interface BabysitterRuntime {
  inbox: PullRequestInbox;
  reconcile(
    reason: string,
    context: ProcessReconcilerRunContext,
    accepting?: () => boolean,
  ): Promise<void>;
  workload(): { running: number };
}

export function createBabysitterRuntime(options: BabysitterRuntimeOptions): BabysitterRuntime {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Babysitter concurrency must be a positive integer.");
  }
  const baseAgent = options.agent;
  assertBabysitterAgent(baseAgent);
  const presetOptions = baseAgent.options;
  const merge = resolveBabysitterMerge(presetOptions.merge, presetOptions.autoMerge);
  const github = options.github;
  const hostIdentity = github.identity()?.trim();
  const normalizedActivityAuthors = options.activityAuthors.map((author) => author.trim().toLowerCase());
  const verifiedHostIdentity = hostIdentity && normalizedActivityAuthors.includes(hostIdentity.toLowerCase())
    ? hostIdentity
    : undefined;
  // Only trust the host identity when it matches the configured allowlist;
  // unverified names must never suppress activity feedback.
  const activityAuthors = verifiedHostIdentity ? [verifiedHostIdentity] : [];
  const pullRequestInbox = new PullRequestInbox({
    ...(options.inboxStorage ? { storage: options.inboxStorage } : { path: options.inboxPath }),
    ...(options.inboxStorage ? { scope: options.agentName ?? baseAgent.name ?? "babysitter" } : {}),
    repositories: options.repositories,
    filter: presetOptions.filter,
    activityAuthors,
    // Three passes on one head without verified progress park the PR until new evidence arrives.
    budgets: { noProgress: 3 },
  });
  const waitPolicy: BabysitterWaitPolicy = {
    workerAuthors: new Set(activityAuthors.flatMap(author => [author.toLowerCase(), `${author.toLowerCase().replace(/\[bot\]$/, "")}[bot]`])),
    pendingReviewChecks: new Set((baseAgent.reviewChecks ?? presetOptions.reviewChecks ?? []).map(name => name.toLowerCase())),
    wakeWhenReady: merge.mode === "direct",
  };
  const schedulerEvent = (name: string, properties: Record<string, unknown> = {}) =>
    options.event?.(name, properties);
  const schedulerError = (name: string, error: unknown, properties: Record<string, unknown> = {}) =>
    options.error?.(name, error, properties);
  const active = new Set<string>();
  const execFileAsync = promisify(execFile);
  async function readRest(path: string, projection = ".[]", signal?: AbortSignal) {
    const repository = path.split("/").slice(1, 3).join("/");
    const result = await github.command(
      ["api", "--paginate", path, "--jq", `${projection} | @json`],
      { repository, timeout: 60_000, signal },
    );
    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function readThreads(repository: string, number: number, signal?: AbortSignal) {
    return readPullRequestThreads(
      async (query, variables) => {
        const reservation = await github.ensureGraphQLBudget(repository, { cost: 1, signal });
        reservation.submit();
        const args = ["api", "graphql", "-f", `query=${query}`];
        for (const [key, value] of Object.entries(variables)) {
          if (value === null) continue;
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Server capability inputs are untyped until this runtime boundary validates them.
          args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
        }
        try {
          const result = await github.command(args, { repository, timeout: 60_000, signal });
          return JSON.parse(result.stdout);
        } finally {
          reservation.settle(1);
        }
      },
      repository,
      number,
    );
  }

  function isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    );
  }

  function cancelWhenPullRequestStops(
    claim: Claim,
    controller: AbortController,
    providerDirectory: () => string | undefined,
  ): () => void {
    let stopped = false,
      polling = false;
    const check = createClaimStopCheck(
      claim,
      () => pullRequestInbox.get(claim.snapshot.repository, claim.snapshot.number),
      async () => {
        const cwd = providerDirectory();
        if (!cwd) return undefined;
        const result = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
          cwd,
          encoding: "utf8",
          timeout: 3000,
          maxBuffer: 1024,
        });
        return result.stdout.trim();
      },
    );
    const poll = async () => {
      if (stopped || polling || controller.signal.aborted) return;
      polling = true;
      try {
        const reason = await check();
        if (reason && !stopped) controller.abort(new DOMException(reason, "AbortError"));
      } catch {
        if (!stopped)
          controller.abort(
            new DOMException("Unable to verify active pull request state.", "AbortError"),
          );
      } finally {
        polling = false;
      }
    };
    // Local snapshots handle cancellation. Git is consulted only after a head
    // change, to distinguish the provider's repair push from an external push.
    const interval = setInterval(() => {
      void poll();
    }, 2000);
    void poll();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  const requiredChecks = createGitHubRequiredCheckPolicyReader(async (path) => {
    const repository = path.split("/").slice(1, 3).join("/");
    try {
      const result = await github.command(["api", "--paginate", "--slurp", path], { repository, timeout: 60_000 });
      const pages: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(pages)) return { status: 0 };
      // gh returns one entry per page. Rules are a list; protection endpoints return one object.
      return { status: 200, data: path.includes("/rules/") ? pages.flat() : pages[0], nextPage: null };
    } catch (error) {
      return { status: Number(String(error).match(/HTTP\s+(\d{3})/i)?.[1] ?? 0) };
    }
  });

  /**
   * Merges a PR that inbox evidence, the merge policy, and GitHub's live state all report ready.
   * Returns false, and the PR gets a normal pass, on any doubt.
   */
  async function mergeReadyPullRequest(claim: Claim, owner: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    if (merge.mode !== "direct") return false;
    const { snapshot } = claim;
    const { repository, number } = snapshot;
    // A recovered claim may still represent an interrupted merge whose outcome
    // has not been proven by a closed live read. Keep it out of the repair pass
    // until hydration clears the fence.
    if (await pullRequestInbox.hasMergeIntent(claim)) {
      await pullRequestInbox.release(claim);
      return true;
    }
    const base = snapshot.pr?.base?.ref;
    if (!base) return false;
    const policy = await requiredChecks.read(repository, base);
    const evaluation = evaluateGitHubRequiredChecks(policy, snapshotCheckEvidence(snapshot));
    let decision = directMergeReadiness(snapshot, evaluation.state);
    if (decision.ready && merge.ready) {
      const ready = await merge.ready({ repository, number, head: decision.head, snapshot: structuredClone(snapshot), requiredChecks: evaluation.state });
      if (ready !== true) decision = { ready: false, reason: ready };
    }
    if (!decision.ready) {
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: decision.reason });
      return false;
    }
    let mergedHead = decision.head;
    try {
      // Refresh review threads and atomically revalidate the claim after all
      // readiness checks. A webhook received during this read invalidates the
      // claim, so newly arrived feedback cannot be merged accidentally.
      const threads = await readThreads(repository, number, signal);
      if (!(await pullRequestInbox.hydrate(claim, { threads, threadsHydrated: true, feedbackRefresh: false }))) return false;
      const currentSnapshot = claim.snapshot;
      const currentPolicy = await requiredChecks.read(repository, base);
      const currentEvaluation = evaluateGitHubRequiredChecks(currentPolicy, snapshotCheckEvidence(currentSnapshot));
      decision = directMergeReadiness(currentSnapshot, currentEvaluation.state);
      if (!decision.ready) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: decision.reason });
        return false;
      }
      const head = decision.head;
      mergedHead = head;
      if (merge.ready) {
        const ready = await merge.ready({ repository, number, head, snapshot: structuredClone(currentSnapshot), requiredChecks: currentEvaluation.state });
        if (ready !== true) {
          schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: ready });
          return false;
        }
      }
      const [live] = await readRest(`repos/${repository}/pulls/${number}`, ".", signal);
      const current = liveMergeReadiness(live, head);
      if (!current.ready) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: current.reason });
        return false;
      }
      if (await pullRequestInbox.hasMergeIntent(claim)) {
        await pullRequestInbox.release(claim);
        return true;
      }
      // GitHub rejects the merge when the head no longer matches sha.
      const merged = await pullRequestInbox.merge(claim, async () => {
        const result = await github.command(["api", "-X", "PUT", `repos/${repository}/pulls/${number}/merge`, "-f", `merge_method=${merge.method}`, "-f", `sha=${head}`], { repository, timeout: 60_000, signal });
        const response: unknown = JSON.parse(result.stdout);
        return Boolean(response && hasRuntimeType(response, "object") && "merged" in response && response.merged === true);
      }, `Merged ${head} directly: required checks passed and review threads were resolved.`);
      if (!merged) {
        if (await pullRequestInbox.hasPersistedMergeIntent(repository, number)) {
          await pullRequestInbox.release(claim);
          return true;
        }
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "inbox claim changed or GitHub did not merge the pull request" });
        return false;
      }
    } catch (error) {
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      const pending = await pullRequestInbox.get(repository, number);
      if (pending?.mergeIntent) {
        await pullRequestInbox.release(claim);
        // The next owner must read GitHub before dispatching any repair.
        return true;
      }
      return false;
    }
    schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: mergedHead, avoided_invocation: true });
    return true;
  }

  const postPushGraceMs = options.postPushGraceMs ?? 3 * 60_000;

  async function parkOnPushedHead(claim: Claim, text: string, head: string) {
    await pullRequestInbox.finish(claim, { text, progress: { kind: "verified", evidence: `push:${head}` },
      wait: { ...createCheckWait(claim.snapshot, waitPolicy), headSha: head } });
  }

  /** Retries a provider rate limit three times, then blocks admission for an hour. */
  async function runWithProviderRetry<T>(run: () => Promise<T>, signal: AbortSignal, canRetry: () => boolean = () => true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (isAbortError(error) || !isProviderRateLimit(error) || !canRetry()) throw error;
        if (attempt === 3) {
          await pullRequestInbox.setMeta("provider-quota-blocked-until", Date.now() + 60 * 60_000);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, providerRetryDelayMs));
        signal.throwIfAborted();
      }
    }
  }
  const providerRetryDelayMs = options.providerRetryDelayMs ?? 10_000;

  async function requiredCheckState(snapshot: Snapshot) {
    const base = snapshot.pr?.base?.ref;
    if (!base) return "unknown" as const;
    return evaluateGitHubRequiredChecks(await requiredChecks.read(snapshot.repository, base), snapshotCheckEvidence(snapshot)).state;
  }

  /** Wakes a parked PR only when its new events need a model pass or a direct merge. */
  async function evaluateWaits() {
    for (const snapshot of await pullRequestInbox.waitsToEvaluate()) {
      const keep = shouldKeepWaiting(snapshot, await requiredCheckState(snapshot), waitPolicy);
      const owner = { pullRequest: snapshot.number, repository: snapshot.repository };
      if (keep) {
        await pullRequestInbox.acknowledgeWait(snapshot);
        schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: snapshot.pr?.head?.sha, avoided_invocation: true });
      } else if (await pullRequestInbox.wake(snapshot, `evaluated:${snapshot.generation}:${snapshot.revision ?? 0}`)) {
        schedulerEvent("babysitter.wait.woken", owner);
      }
    }
  }

  /** Moves a stacked PR to the default branch after its parent merged there. */
  async function retargetMergedStackBase(snapshot: Snapshot): Promise<{ from: string; to: string } | undefined> {
    const pr = snapshot.pr;
    const target = pr && nonDefaultBase(pr);
    if (!pr || !target) return undefined;
    const { base, owner } = target;
    const parents = await readRest(`repos/${snapshot.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=10`);
    const to = stackRetargetBase(pr, parents);
    if (!to) return undefined;
    await github.command(["api", "-X", "PATCH", `repos/${snapshot.repository}/pulls/${snapshot.number}`, "-f", `base=${to}`], { repository: snapshot.repository, timeout: 60_000 });
    return { from: base, to };
  }

  function workload() {
    return { running: active.size };
  }

  async function reconcile(
    reason: string,
    { track }: ProcessReconcilerRunContext,
    isAccepting: () => boolean = () => true,
  ) {
    const startedAt = new Date();
    const schedule = {
      id: "babysitter-demand",
      runId: `demand:${startedAt.toISOString()}`,
      scheduledAt: startedAt,
    };
    const { publicUrl, repositories } = options;
    if (!isAccepting()) return;
    const ownerLimit = options.concurrency;
    // A provider that keeps rate-limiting would fail every claim. Park admission until the block ends.
    if (((await pullRequestInbox.metaNumber("provider-quota-blocked-until")) ?? 0) > Date.now()) return;
    // Event-scoped filters cannot be established from the pull-request REST
    // listing alone.  Seeding those entries would admit PRs that have never
    // produced an allowed event (for example, `action: synchronize`).
    const eventScopedBootstrap = Boolean(presetOptions.filter?.actor || presetOptions.filter?.action);
    // Bootstrap once per repository and persist even an empty successful list.
    // Failed reads stay retryable; they must never masquerade as empty success.
    for (const repository of repositories) {
      if (eventScopedBootstrap) continue;
      const key = `bootstrap-rest-v1:${repository}`;
      // SAFETY: This versioned key is written below only with an ISO timestamp object; absent keys return undefined.
      const previous = (await pullRequestInbox.meta(key)) as { at: string } | undefined;
      if (previous && Date.now() - Date.parse(previous.at) < 30 * 60_000) continue;
      // Failed bootstraps retry on the repair timer, not on every owner wake.
      const nextKey = `${key}:next`;
      // SAFETY: This bootstrap retry key is written below only with a numeric epoch timestamp; absent keys return undefined.
      if ((((await pullRequestInbox.meta(nextKey)) as number | undefined) ?? 0) > Date.now()) continue;
      await pullRequestInbox.setMeta(nextKey, Date.now() + 2 * 60_000);
      try {
        const result = await github.command(
          [
            "api",
            "--paginate",
            `repos/${repository}/pulls?state=open&per_page=100`,
            "--jq",
            ".[] | @json",
          ],
          { repository, timeout: 60_000 },
        );
        const prs = result.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        for (const pr of prs) await pullRequestInbox.seed(repository, normalizePullRequest(pr));
        await pullRequestInbox.setMeta(key, { at: new Date().toISOString() });
      } catch (error) {
        schedulerError("babysitter.bootstrap.failed", error, { repository });
      }
    }
    try {
      await reconcileOneSnapshot(pullRequestInbox, readRest, Date.now(), readThreads, activityAuthors);
    } catch (error) {
      schedulerError("babysitter.snapshot.reconcile.failed", error);
    }
    // Recover leases that expired while the host was stopped before claiming work.
    await pullRequestInbox.recoverLeases();
    try {
      await evaluateWaits();
      for (const snapshot of await pullRequestInbox.summary()) {
        if (snapshot.dirty && !snapshot.wait && snapshot.head && snapshot.progressBudget?.exhausted
          && snapshot.progressBudget.head === snapshot.head
          && snapshot.reasons.some(reason => reason !== "no-progress-budget-exhausted")) {
          await pullRequestInbox.resetProgressBudget(snapshot.repository, snapshot.number, snapshot.head, "New repair evidence arrived after exhaustion.");
        }
      }
    } catch (error) {
      schedulerError("babysitter.wait.evaluate.failed", error);
    }
    // Delivery IDs deduplicate redeliveries; their payloads only help inspection.
    if (((await pullRequestInbox.metaNumber("deliveries-prune-next")) ?? 0) <= Date.now()) {
      await pullRequestInbox.setMeta("deliveries-prune-next", Date.now() + 60 * 60_000);
      await pullRequestInbox.pruneDeliveries();
    }
    if (!isAccepting()) return;
    // The durable inbox is the sole eligibility checkpoint. A second work
    // tracker checkpoint used to swallow new webhook generations and leak
    // their leases for two hours.
    const jobs = await pullRequestInbox.claim(Math.max(0, ownerLimit - active.size));
    if (!jobs.length) return; // tracking an already-resolved batch creates wake loops
    for (const claim of jobs) active.add(`${claim.snapshot.repository}#${claim.snapshot.number}`);
    schedulerEvent("babysitter.queue.selected", {
      reason,
      selected: jobs.length,
      owner_limit: ownerLimit,
      active_owners: active.size,
    });
    const batchStartedAt = Date.now();

    schedulerEvent("babysitter.batch.started", {
      jobs: jobs.length,
      maxOwners: ownerLimit,
      reason,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    });
    const batch = Promise.allSettled(
      jobs.map(async (inboxClaim) => {
        const repository = inboxClaim.snapshot.repository;
        const number = inboxClaim.snapshot.number;
        const runId = `${schedule.runId}:${repository}:pr-${number}:generation-${inboxClaim.generation}`;
        const owner = { pullRequest: number, repository, runId };
        const startedAt = Date.now();
        let outcome = "completed";
        let disposition: BabysitterPassResult["disposition"] | undefined;
        let resultText = "";
        let pushSucceeded = false;
        let pushedHead: string | undefined;
        let pushedAt: ReturnType<typeof setTimeout> | undefined;
        schedulerEvent("babysitter.owner.started", { maxOwners: ownerLimit, ...owner });
        const passController = new AbortController();
        const passSignal = AbortSignal.any([
          AbortSignal.timeout(60 * 60 * 1000),
          passController.signal,
        ]);
        let providerDirectory: string | undefined;
        const preparedDirectories = new Set<string>();
        const stopPullRequestWatch = cancelWhenPullRequestStops(
          inboxClaim,
          passController,
          () => providerDirectory,
        );
        try {
          // Unknown PRs (a comment arriving before opened) need exactly one
          // targeted REST hydration. Normal webhook claims use the local head.
          if (
            !(await hydrateSnapshot(
              pullRequestInbox,
              inboxClaim,
              (path, projection) => readRest(path, projection, passSignal),
              (repository, number) => readThreads(repository, number, passSignal),
              activityAuthors,
            ))
          ) {
            await pullRequestInbox.release(inboxClaim);
            return;
          }
          // A merge intent is a durable fence. Hydration clears it only after
          // a closed PR read proves the external merge completed. Keep a
          // recovered or superseded claim out of the repair path while the
          // outcome is still inconclusive, even when its lease identity has
          // changed since the intent was recorded.
          if (await pullRequestInbox.hasPersistedMergeIntent(repository, number)) {
            await pullRequestInbox.release(inboxClaim);
            return;
          }
          if (!pullRequestInbox.eligible(repository, inboxClaim.snapshot.pr)) {
            await pullRequestInbox.finish(inboxClaim, {
              text: "PR closed or outside the configured filter.",
              terminal: true,
            });
            return;
          }
          const retargeted = await retargetMergedStackBase(inboxClaim.snapshot);
          if (retargeted) {
            // GitHub sends an edited event for the new base; that event wakes the next pass.
            await pullRequestInbox.finish(inboxClaim, { text: `Retargeted from ${retargeted.from} to ${retargeted.to} after the parent pull request merged.` });
            schedulerEvent("babysitter.stack.retargeted", { ...owner, ...retargeted });
            return;
          }
          if (merge.mode === "direct" && (await mergeReadyPullRequest(inboxClaim, owner, passSignal))) return;
          const pullRequest = snapshotPullRequest(inboxClaim.snapshot);
          const webhookSnapshot = inboxClaim.snapshot;
          await github.withPullRequestCheckout(
            {
              headRef: pullRequest.headRefName,
              headRepository: pullRequest.headRepository?.nameWithOwner,
              headSha: pullRequest.headRefOid,
              number: pullRequest.number,
              repository,
            },
            async (prepared) => {
              const checkout = prepared.path;
              schedulerEvent("babysitter.checkout.ready", {
                repository,
                pull_request: pullRequest.number,
                head_sha: pullRequest.headRefOid,
              });
              const context = {
                preparedCheckout: checkout,
                pullRequestHead: pullRequest.headRefOid,
                pullRequestNumber: pullRequest.number,
                pullRequestRepository: repository,
                pullRequestSourceBranch: pullRequest.headRefName,
                pullRequestSourceRepository:
                  pullRequest.headRepository?.nameWithOwner || "(unavailable)",
                pullRequestTitle: pullRequest.title,
                pullRequestUrl: pullRequest.url,
              };
              const abortSignal = AbortSignal.any([prepared.signal, passSignal]);
              // Check durable ownership at dispatch, including after admission I/O.
              // The cancellation watcher alone leaves a window for a reclaimed worker.
              const assertLease = async () => {
                abortSignal.throwIfAborted();
                const current = await pullRequestInbox.get(repository, number);
                if (current?.lease !== inboxClaim.token || current.leaseUntil <= Date.now()) {
                  throw new DOMException("Pull request lease lost.", "AbortError");
                }
                // New feedback keeps the lease but invalidates the worker's evidence.
                if (current.generation !== inboxClaim.generation) {
                  throw new DOMException("Pull request evidence changed.", "AbortError");
                }
              };
              let externalOperationStarted = false;
              const operationHost: Pick<GitHubHost, "command" | "ensureGraphQLBudget"> = {
                command: async (args, request) => {
                  await assertLease();
                  if ((args.includes("-X") || args.includes("--method")) && !args.includes("GET")
                    || args.some(arg => /^query=\s*mutation\b/.test(arg))) externalOperationStarted = true;
                  return await github.command(args, request);
                },
                ensureGraphQLBudget: async (...args) => {
                  await assertLease();
                  return await github.ensureGraphQLBudget(...args);
                },
              };
              const operations = createGitHubPullRequestOperations(operationHost, {
                repository,
                number,
                expectedHeadOid: pullRequest.headRefOid,
                signal: abortSignal,
                autoMerge: merge.mode === "auto",
                eligible: (current) =>
                  pullRequestInbox.eligible(repository, normalizePullRequest(current)),
                push: async () => {
                  if (!providerDirectory) throw new Error("The repair workspace is not prepared.");
                  await assertLease();
                  const renew = setInterval(() => {
                    void pullRequestInbox.renew(inboxClaim, Date.now() + 2 * 60 * 60_000)
                      .then((renewed) => { if (!renewed) passController.abort(); }, () => passController.abort());
                  }, 30_000);
                  try {
                    const result = await prepared.push(providerDirectory, {
                      signal: abortSignal,
                      beforePush: assertLease,
                    });
                    // A no-op push does not advance the remote head and emits
                    // no synchronize webhook; do not park this generation as
                    // though a repair created a wake-up event.
                    pushSucceeded = result !== pullRequest.headRefOid;
                    if (pushSucceeded) {
                      pushedHead = result;
                      // The push starts checks and reviews whose webhooks resume the PR.
                      // A worker that keeps watching them only holds a slot.
                      pushedAt ??= setTimeout(() => passController.abort(new DOMException("Repair pushed; waiting for check and review webhooks.", "TimeoutError")), postPushGraceMs);
                    }
                    return result;
                  } finally {
                    clearInterval(renew);
                  }
                },
              });
              const settings = getAgentLayerOptions(baseAgent);
              const driver = settings?.driver;
              if (
                !driver ||
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Server capability inputs are untyped until this runtime boundary validates them.
                typeof driver !== "object" ||
                !("kind" in driver) ||
                (driver.kind !== "codex" && driver.kind !== "claude-code")
              ) {
                throw new Error(
                  "Babysitter requires a Codex or Claude Code driver for its isolated Git checkout.",
                );
              }
  // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The preceding schema guard establishes the asserted operation shape.
              const workerDriver = driver as
                | (CodexDriverOptions<BabysitterPassResult> & { kind: "codex" })
                | (ClaudeCodeDriverOptions<BabysitterPassResult> & { kind: "claude-code" });
              const activityEnabled = !!verifiedHostIdentity;
              const workerName = "babysitter-worker";
              const agent = defineAgent({
                extends: baseAgent,
                name: workerName,
                channels: {
                  github: github.channel({
                    activity: activityEnabled,
                    pullRequest: { filter: presetOptions.filter },
                  }),
                },
                capabilities: [repairCapability(operations, merge.mode === "auto")],
                driver: {
                  ...workerDriver,
                  permissions: "allow-edits",
                  env: async (context) => {
                    const environment =
                      workerDriver.env === undefined
                        ? undefined
                        : await resolveRuntimeValue(workerDriver.env, context);
                    return repairEnvironment(environment, join(checkout, ".vitehub-github-auth"), prepared.env);
                  },
                  launch: async (context) => {
                    if (context.purpose !== "inspection") {
                      if (!preparedDirectories.has(context.cwd)) {
                        await prepared.prepareWorkspace(context.cwd);
                        preparedDirectories.add(context.cwd);
                      }
                      providerDirectory = context.cwd;
                    }
                    return workerDriver.launch
                      ? await resolveRuntimeValue(workerDriver.launch, context)
                      : { command: context.command };
                  },
                },
                workspace: {
                  commit: false,
                  mode: "write",
                  store: { provider: "local", root: checkout },
                },
              });
              const prompt = `Repair PR #${number} in ${repository}. Expected HEAD ${pullRequest.headRefOid}, source branch ${pullRequest.headRefName}, source repository ${pullRequest.headRepository?.nameWithOwner ?? "unavailable"}. ${pullRequest.url}`;
              const snapshotContext = snapshotPrompt(webhookSnapshot);
              const userMessage = `${prompt}\n\n${snapshotContext}`;
              assertPromptFits(userMessage);
              schedulerEvent("babysitter.context.prepared", {
                repository,
                pull_request: number,
                characters: snapshotContext.length,
                format: "xml",
              });
              const githubRun = await createGitHubPullRequestRun(repository, pullRequest, {
                agentName: workerName,
                runId,
                publicUrl: publicUrl ?? resolvePublicUrl({ agentName: options.agentName ?? baseAgent.name }),
              });
              // The GitHub run helper uses a stable PR thread id. Scope the
              // provider session to this pass so a new checkout never
              // resumes a Codex process whose temporary cwd was deleted.
              githubRun.threadId = `${githubRun.threadId}:${runId}`;
              const result = await runWithProviderRetry(() => runAgent(
                agent,
                {
                  runtime: "vite",
                  run: githubRun,
                  memo: (_key, create) => create(),
                  waitUntil: () => {},
                },
                {
                  abortSignal,
                  context,
                  messages: [createMessage({ role: "user", text: userMessage })],
                },
                { schedule: { ...schedule, runId }, output: "drained" },
              ), abortSignal, () => !pushSucceeded && !externalOperationStarted);
              const validated = babysitterPassResultSchema["~standard"].validate(result);
              if ("issues" in validated)
                throw new Error("Babysitter returned an invalid pass result.");
              disposition = validated.value.disposition;
              resultText = validated.value.text;
            },
            { signal: passSignal, timeout: 60 * 60 * 1000 },
          );

          const current = await pullRequestInbox.get(repository, number);
          const terminal = current?.status === "terminal";
          if (terminal) {
            await pullRequestInbox.finish(inboxClaim, { text: resultText, terminal: true });
          } else if (pushedHead) {
            outcome = "waiting";
            await parkOnPushedHead(inboxClaim, resultText, pushedHead);
          } else if (disposition === "park" && isExternalWaitResult(resultText) && current?.pr?.head?.sha === pullRequest.headRefOid) {
            // A reproduced external gate waits on this head until its evidence changes.
            outcome = "waiting";
            // Evidence that changed during the pass makes this wait stale, and the PR stays claimable.
            await pullRequestInbox.finish(inboxClaim, { text: resultText, progress: { kind: "no-progress" },
              wait: createCheckWait(inboxClaim.snapshot, waitPolicy) });
          } else {
            // A park that names no external gate still consumed a pass without progress.
            outcome = disposition === "park" ? "completed" : "retry";
            await pullRequestInbox.finish(inboxClaim, { text: resultText, retry: disposition !== "park", progress: { kind: "no-progress" } });
          }
        } catch (error) {
          if (pushedHead && (await pullRequestInbox.get(repository, number))?.status !== "terminal") {
            // The repair reached GitHub. Its checks and reviews resume the PR.
            outcome = "waiting";
            await parkOnPushedHead(inboxClaim, error instanceof Error ? error.message : String(error), pushedHead);
            const expected = isAbortError(error) || (error instanceof Error && error.name === "TimeoutError") || github.isRateLimitError(error);
            if (!expected) schedulerError("babysitter.owner.failed", error, owner);
          } else if (isAbortError(error)) {
            outcome = "completed";
            await pullRequestInbox.finish(inboxClaim, {
              text: pushSucceeded
                ? "Repair pushed; waiting for new webhook evidence."
                : "Pass interrupted; current webhook state retained.",
              retry: !pushSucceeded,
              terminal: (await pullRequestInbox.get(repository, number))?.status === "terminal",
            });
            schedulerEvent("babysitter.owner.cancelled", {
              reason: "pull-request-state-changed-or-aborted",
              ...owner,
            });
          } else if (github.isRateLimitError(error)) {
            outcome = "deferred";
            await pullRequestInbox.finish(inboxClaim, {
              text: pushSucceeded
                ? "Repair pushed; waiting for new webhook evidence."
                : "GitHub rate limit; retrying after budget reset.",
              retry: !pushSucceeded,
            });
            schedulerEvent("babysitter.owner.deferred", { reason: "github-rate-limit", ...owner });
          } else {
            outcome = "failed";
            if (/AGENT_R0767|head.*(?:mismatch|changed)|expected.*head/i.test(String(error))) {
              await pullRequestInbox.hydrate(inboxClaim, { refresh: true });
            }
            await pullRequestInbox.finish(inboxClaim, {
              text: error instanceof Error ? error.message : String(error),
              retry: !pushSucceeded,
            });
            schedulerError("babysitter.owner.failed", error, owner);
          }
        } finally {
          clearTimeout(pushedAt);
          stopPullRequestWatch();
          schedulerEvent("babysitter.owner.finished", {
            durationMs: Date.now() - startedAt,
            outcome,
            ...owner,
          });
          active.delete(`${repository}#${number}`);
          options.wake?.();
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        schedulerEvent("babysitter.batch.finished", {
          durationMs: Date.now() - batchStartedAt,
          jobs: jobs.length,
          maxOwners: ownerLimit,
          repositories,
          scheduleId: schedule.runId || schedule.id,
        });
      })
      .catch((error) =>
        schedulerError("babysitter.batch.failed", error, { scheduleId: schedule.runId }),
      );
    track(batch);
  }

  return { inbox: pullRequestInbox, reconcile, workload };
}

function assertBabysitterAgent(agent: AgentInput): asserts agent is BabysitterAgent {
  if (
    !getAgentLayerOptions(agent) ||
    !("options" in agent) ||
    !agent.options ||
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Server capability inputs are untyped until this runtime boundary validates them.
    !hasRuntimeType(agent.options, "object") ||
    !("autoMerge" in agent.options) ||
    !hasRuntimeType(agent.options.autoMerge, "boolean") ||
    !("filter" in agent.options) ||
    !agent.options.filter ||
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Agent options are validated at runtime.
    !hasRuntimeType(agent.options.filter, "object") ||
    Array.isArray(agent.options.filter)
  ) {
    throw new Error("Babysitter runtime requires a configured Babysitter Agent Definition.");
  }
}
