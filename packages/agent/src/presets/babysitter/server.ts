import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { agentBuildRevision } from "../../internal/build-revision.ts";
import { GitHubDependencyConflictError } from "../../server/github-install-inputs.ts";
import * as v from "valibot";
import { join } from "node:path";
import { readAsyncMerge, requestAsyncMerge } from "./async-merge.ts";
import { prepareGitHubRepairBase } from "../../server/github-repair.ts";
import { assertGitHubDependenciesCurrent, GitHubWorkspaceInstallError, installGitHubPullRequestWorkspace } from "../../server/github-install.ts";
import { resolvePublicUrl, resolveRuntimeValue } from "@vite-hub/runtime";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import { resolveRegisteredWorkspaceDefinition } from "@vite-hub/workspace";
import type { ProcessReconcilerRunContext } from "@vite-hub/runtime/node";
import { createMessage, defineAgent, runAgent, publishAgentActivity } from "../../index.ts";
import { resolveAgentCapabilityDefinitions } from "../../capability-runtime.ts";
import type { AgentCapabilitiesResolver, AgentInput, AgentProviderCredentialContext, AgentProviderLaunchContext, ClaudeCodeDriverOptions, CodexDriverOptions } from "../../index.ts";
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
  claimStopReason,
  hydrateSnapshot,
  reconcileOneSnapshot,
  readPullRequestThreads,
  detectChangedPullRequests,
  probeChangedSnapshots,
} from "../../server/github-inbox.ts";
import type { Claim, PullRequestInboxStorage, ReadGraphql, Snapshot } from "../../server/github-inbox.ts";
import { hydrateFailedCiEvidence } from "../../server/github-inbox/ci-evidence.ts";
import type { PullRequestWake } from "../../server/github-inbox/wait-state.ts";
import { createHash } from "node:crypto";
import { babysitterPassResultSchema } from "../babysitter.ts";
import type { BabysitterAgent, BabysitterPassResult } from "../babysitter.ts";
import { asMetadataTarget, copyDefinitionDecorations, getAgentLayerOptions } from "../../agent-layers.ts";
import { importBoxCommit } from "./box-commit.ts";
import { createProviderHeadReader } from "./checkout-watch.ts";
import { importBoxRepairFiles, importBoxRepairWorkspace, publishBoxDependencies } from "./box-repair.ts";
import { activeProviderBox } from "../../internal/provider-box.ts";
import { repairCapability, repairEnvironment } from "./repair.ts";
import { createGitHubRequiredCheckPolicyReader, evaluateGitHubRequiredChecks } from "../../server/github-required-checks.ts";
import { directMergeReadiness, feedbackFingerprints, liveMergeReadiness, resolveBabysitterMerge, snapshotCheckEvidence, mergeReviewEvidenceKey } from "./merge.ts";
import { checksDependencyEvidence, createCheckWait, failureKeys, hasPendingChecks, reviewCheckRunning, wakeReasons, type BabysitterWaitPolicy } from "./wait.ts";
import { nonDefaultBase, stackRetargetBase, directMergeBranchSafety } from "./stack.ts";
import { babysitterModelAdmission, type BabysitterAdmissionResult } from "./admission.ts";
import { boundedMergeReady } from "./merge-ready.ts";
import { createBabysitterInstaller } from "./install.ts";
import { hasFailedActions, rerunFailedActions } from "./ci-recovery.ts";
import { createBabysitterStatusRecovery, isWorkerBlocker } from "./status-recovery.ts";

declare const __VITEHUB_AGENT_BUILD_REVISION__: string;

export interface BabysitterRuntimeOptions {
  agent: AgentInput;
  /** Discovered Agent name for per-Agent public URLs. Defaults to the definition name. */
  agentName?: string;
  github: GitHubHost;
  /** Private `node:sqlite` inbox file. Set this or `inboxStorage`. */
  inboxPath?: string;
  /** Inbox tables in shared SQL storage, for example `agentState.extension("babysitter")`. */
  inboxStorage?: PullRequestInboxStorage;
  /** Separates this Agent's inbox in shared storage. Defaults to the Agent name. */
  inboxScope?: string;
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
  admission?: () => Promise<Pick<BabysitterAdmissionResult, "accepting" | "hostOnly" | "reason" | "retryAt" | "detail">>;
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
  const noProgressBudget = baseAgent.noProgressBudget ?? presetOptions.noProgressBudget ?? 3;
  const pullRequestInbox = new PullRequestInbox({
    ...(options.inboxStorage ? { storage: options.inboxStorage, scope: options.inboxScope ?? options.agentName ?? baseAgent.name ?? "babysitter" } : { path: options.inboxPath }),
    repositories: options.repositories,
    filter: presetOptions.filter,
    activityAuthors,
    budgets: noProgressBudget === false ? {} : { noProgress: noProgressBudget },
  });
  const deferWhilePending = baseAgent.deferWhilePending ?? presetOptions.deferWhilePending ?? true;
  const waitPolicy: BabysitterWaitPolicy = {
    ignoreFeedbackAuthors: new Set((baseAgent.ignoreFeedbackAuthors ?? presetOptions.ignoreFeedbackAuthors ?? []).map(author => author.trim().toLowerCase())),
    workerAuthors: new Set(activityAuthors.flatMap(author => [author.toLowerCase(), `${author.toLowerCase().replace(/\[bot\]$/, "")}[bot]`])),
    pendingReviewChecks: new Set((presetOptions.reviewChecks ?? []).map(name => name.toLowerCase())),
    wakeWhenReady: merge.mode === "direct",
    noFindingsReviews: baseAgent.noFindingsReviews ?? presetOptions.noFindingsReviews ?? [],
  };
  const schedulerEvent = (name: string, properties: Record<string, unknown> = {}) =>
    options.event?.(name, properties);
  const schedulerError = (name: string, error: unknown, properties: Record<string, unknown> = {}) =>
    options.error?.(name, error, properties);
  const statusChannel = verifiedHostIdentity ? github.channel({ activity: true, pullRequest: { workspace: false } }) : undefined;
  const statusRecovery = createBabysitterStatusRecovery({
    inbox: pullRequestInbox,
    // Built packages carry this fingerprint; direct source hosts compute the same inputs.
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Guard a compile-time global that is absent when running package sources.
    revision: baseAgent.version ?? (typeof __VITEHUB_AGENT_BUILD_REVISION__ === "undefined" ? agentBuildRevision(fileURLToPath(new URL("../../../", import.meta.url))) : __VITEHUB_AGENT_BUILD_REVISION__),
    publish: statusChannel ? (pending, abortSignal) => publishAgentActivity({ name: `${options.agentName ?? baseAgent.name ?? "babysitter"}-worker`, channels: { github: statusChannel } }, {
      channelId: "github", target: { repository: pending.repository, issue: pending.number }, activity: pending.activity, abortSignal,
    }) : undefined,
    event: schedulerEvent,
    error: schedulerError,
  });
  const active = new Set<string>();
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

  /** A GraphQL reader that reserves `cost` points of the repository's shared budget per query. */
  function readGraphql(repository: string, cost: number, signal?: AbortSignal): ReadGraphql {
    return async (query, variables) => {
      const reservation = await github.ensureGraphQLBudget(repository, { cost, signal });
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
        reservation.settle(cost);
      }
    };
  }

  async function readThreads(repository: string, number: number, signal?: AbortSignal) {
    return readPullRequestThreads(readGraphql(repository, 1, signal), repository, number);
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
    pushedHead: () => string | undefined,
  ): () => void {
    let stopped = false,
      polling = false;
    const check = createClaimStopCheck(
      claim,
      () => pullRequestInbox.get(claim.snapshot.repository, claim.snapshot.number),
      createProviderHeadReader(providerDirectory, pushedHead),
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
      const list = path.includes("/rules/");
      const result = await github.command(["api", "--paginate", path, "--jq", list ? ".[] | @json" : ". | @json"], { repository, timeout: 60_000 });
      const pages: unknown[] = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      // gh emits one JSON value per line. Rules are a list; protection endpoints return one object.
      return { status: 200, data: list ? pages : pages[0], nextPage: null };
    } catch (error) {
      return { status: Number(String(error).match(/HTTP\s+(\d{3})/i)?.[1] ?? 0) };
    }
  });

  /**
   * Merges a PR that inbox evidence, the merge policy, and GitHub's live state all report ready.
   * Returns `not-ready` for a normal pass, and `blocked` while a merge outcome is unknown.
   */
  async function mergeReadyPullRequest(claim: Claim, owner: Record<string, unknown>, signal: AbortSignal): Promise<"merged" | "blocked" | "not-ready"> {
    if (merge.mode !== "direct") return "not-ready";
    const { snapshot } = claim;
    const { repository, number } = snapshot;
    const base = snapshot.pr?.base?.ref;
    if (!base) return "not-ready";
    const pending = await pullRequestInbox.directMergeAttempt(repository, number);
    const parkMerge = async (reason: string) => {
      await pullRequestInbox.finish(claim, { text: reason, wait: { ...createCheckWait(snapshot, waitPolicy), kind: "external", reason, retryAt: Date.now() + 30_000 } });
      return "blocked" as const;
    };
    if (pending) {
      try {
        const [live] = await readRest(`repos/${repository}/pulls/${number}`, ".", signal);
        const state = isRuntimeRecord(live) && hasRuntimeType(live.state, "string") ? live.state : undefined;
        const mergedAt = isRuntimeRecord(live) && hasRuntimeType(live.merged_at, "string") ? live.merged_at : undefined;
        if (state?.toLowerCase() !== "open" && mergedAt) {
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          await pullRequestInbox.finish(claim, { text: "Direct merge outcome reconciled: GitHub reports the pull request merged.", terminal: true });
          schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: pending.head, avoided_invocation: true });
          return "merged";
        }
        const reconcileEnqueued = async (): Promise<"merged" | "blocked"> => {
          const [repositoryOwner, name] = repository.split("/");
          const response = await readGraphql(repository, 1, signal)(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state headRefOid mergeQueueEntry{id}}}}`, { owner: repositoryOwner, name, number });
          const queued = v.parse(v.object({ data: v.object({ repository: v.object({ pullRequest: v.object({
            state: v.string(), headRefOid: v.string(), mergeQueueEntry: v.nullable(v.object({ id: v.string() })),
          }) }) }) }), response).data.repository.pullRequest;
          // Neither queue absence nor a timeline removal identifies this accepted
          // request. beforeCommit may be a synthetic merge-group commit, and event
          // timestamps cannot establish request ownership. Keep the fence.
          const terminal = queued.state === "MERGED" || queued.state === "CLOSED";
          const headChanged = /^[a-f\d]{40}$/i.test(queued.headRefOid) && queued.headRefOid !== pending.head;
          if (!terminal && !headChanged) return await parkMerge("Waiting for a definitive GitHub merge queue outcome.");
          await pullRequestInbox.hydrate(claim, { refresh: true });
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          await pullRequestInbox.finish(claim, { text: `Enqueued merge reconciled: ${terminal ? queued.state.toLowerCase() : "expected head changed"}.`, terminal, retry: !terminal });
          if (queued.state === "MERGED") schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: pending.head, avoided_invocation: true });
          return queued.state === "MERGED" ? "merged" : "blocked";
        };
        if (pending.enqueued) return await reconcileEnqueued();
        if (pending.requestId) {
          const result = await readAsyncMerge(github, repository, number, pending.requestId, signal).catch(async (error: unknown) => {
            if (!(error instanceof Error) || !/HTTP 404/.test(error.message)) throw error;
            // Result UUIDs expire after 24 hours. A successful live PR read above
            // proves this repository is accessible; an expired UUID must not
            // strand a closed PR or bypass the current head's normal merge gates.
            const liveHead = isRuntimeRecord(live) && isRuntimeRecord(live.head) ? live.head.sha : undefined;
            if ((state?.toLowerCase() !== "open" && state?.toLowerCase() !== "closed") || !hasRuntimeType(liveHead, "string") || !/^[a-f\d]{40}$/i.test(liveHead)) throw error;
            await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
            await pullRequestInbox.finish(claim, { text: `Expired GitHub merge result reconciled at head ${liveHead}; rechecking normal gates.`, retry: state.toLowerCase() === "open", terminal: state.toLowerCase() === "closed" });
            return undefined;
          });
          if (!result) return "blocked";
          if (result.status === "pending") return await parkMerge(`Waiting for GitHub merge request ${pending.requestId}.`);
          if (result.status === "enqueued") {
            if (!await pullRequestInbox.recordDirectMergeEnqueued(repository, number, pending.token)) throw new Error("Merge attempt changed before its enqueued result could be recorded.");
            return await reconcileEnqueued();
          }
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          const merged = result.status === "merged";
          await pullRequestInbox.finish(claim, { text: merged ? "Asynchronous merge confirmed by GitHub." : `GitHub merge failed: ${result.details.message}`, terminal: merged, retry: !merged });
          if (merged) schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: pending.head, avoided_invocation: true });
          return merged ? "merged" : "blocked";
        }
        // A legacy synchronous attempt can be reconciled from live PR state.
        // An asynchronous request without a saved UUID may still be running.
        // Re-admit it through every gate below, then let GitHub serialize the
        // duplicate request and return its UUID. Never clear it just for being open.
        if (!pending.asynchronous || state?.toLowerCase() !== "open") {
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          await pullRequestInbox.finish(claim, { text: "Direct merge outcome reconciled as not merged; retrying the verified pull request.", retry: state?.toLowerCase() === "open", terminal: state?.toLowerCase() === "closed" });
          return "blocked";
        }
        const liveHead = isRuntimeRecord(live) && isRuntimeRecord(live.head) ? live.head.sha : undefined;
        if (hasRuntimeType(liveHead, "string") && /^[a-f\d]{40}$/i.test(liveHead) && liveHead !== pending.head) {
          // GitHub's expected-head fence prevents the old request from merging
          // this new head. Admit the new head through every normal gate again.
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          await pullRequestInbox.finish(claim, { text: "Unconfirmed merge head changed; retrying current GitHub state.", retry: true });
          return "blocked";
        }
      } catch (error) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: `merge outcome unknown: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}` });
        return await parkMerge("GitHub merge outcome could not be reconciled; retrying the provider read.");
      }
    }
    if (signal.aborted) return "blocked";
    const policy = await requiredChecks.read(repository, base);
    const evaluation = evaluateGitHubRequiredChecks(policy, snapshotCheckEvidence(snapshot));
    const savedAssessment = await pullRequestInbox.meta(`review-assessment:${repository}#${number}`);
    // Version 1 also acknowledged feedback after a push without an explicit review.
    const assessment = isRuntimeRecord(savedAssessment) && savedAssessment.version === 2 ? savedAssessment : undefined;
    const reviewedEvidenceKey = isRuntimeRecord(assessment) && assessment.head === snapshot.pr?.head?.sha && hasRuntimeType(assessment.evidenceKey, "string") ? assessment.evidenceKey : undefined;
    const assessedFeedback = new Set(isRuntimeRecord(assessment) && Array.isArray(assessment.feedback) ? assessment.feedback.filter(item => hasRuntimeType(item, "string")) : []);
    let decision = directMergeReadiness(snapshot, evaluation.state, { ...waitPolicy, assessedFeedback, reviewedEvidenceKey });
    if (decision.ready && merge.ready) {
      const callback = merge.ready;
      const head = decision.head;
      const ready = await boundedMergeReady(() => callback({ repository, number, head, snapshot: structuredClone(snapshot), requiredChecks: evaluation.state }), signal);
      if (signal.aborted) return "blocked";
      if (ready !== true) decision = { ready: false, reason: ready };
    }
    if (!decision.ready) {
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: decision.reason });
      return pending?.asynchronous ? await parkMerge(`Unconfirmed merge is waiting for ${decision.reason}.`) : "not-ready";
    }
    let mergeStarted = false;
    const mergeToken = pending?.token ?? claim.token;
    try {
      const [live] = await readRest(`repos/${repository}/pulls/${number}`, ".", signal);
      const current = liveMergeReadiness(live, decision.head);
      if (!current.ready) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: current.reason });
        return pending?.asynchronous ? await parkMerge(`Unconfirmed merge is waiting for ${current.reason}.`) : "not-ready";
      }
      const [repositorySettings] = await readRest(`repos/${repository}`, ".", signal);
      const children = await readRest(`repos/${repository}/pulls?state=open&base=${encodeURIComponent(snapshot.pr?.head?.ref ?? "")}&per_page=100`, ".[]", signal);
      const branchSafety = directMergeBranchSafety(repositorySettings, live, children);
      if (branchSafety !== true) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: branchSafety });
        return pending?.asynchronous ? await parkMerge(`Unconfirmed merge is waiting for ${branchSafety}.`) : "not-ready";
      }
      // Revalidate the durable lease and revision after the live provider read and
      // immediately before the irreversible merge request. A webhook or another
      // worker that changed the inbox invalidates this claim.
      if (!(await pullRequestInbox.isClaimCurrent(claim))) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "claim changed before merge" });
        return "not-ready";
      }
      signal.throwIfAborted();
      if (!pending && !(await pullRequestInbox.beginDirectMerge(claim, decision.head, true))) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "merge attempt already in flight or claim changed" });
        return "blocked";
      }
      mergeStarted = true;
      const response = await requestAsyncMerge(github, repository, number, decision.head, merge.method, signal);
      if (response.status === "pending") {
        if (!await pullRequestInbox.recordDirectMergeRequest(repository, number, mergeToken, response.details.uuid)) throw new Error("Merge attempt changed before its UUID could be recorded.");
        return await parkMerge(`Waiting for GitHub merge request ${response.details.uuid}.`);
      }
      if (response.status !== "merged") {
        if (response.status === "enqueued" && !await pullRequestInbox.recordDirectMergeEnqueued(repository, number, mergeToken)) throw new Error("Merge attempt changed before its enqueued result could be recorded.");
        if (response.status === "failed") await pullRequestInbox.clearDirectMerge(repository, number, mergeToken);
        return await parkMerge(response.status === "failed" ? `GitHub merge failed: ${response.details.message}` : "GitHub enqueued the pull request; waiting for its merge webhook.");
      }
    } catch (error) {
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      // Definite HTTP rejections did not enqueue a merge. Keep the fence for
      // timeouts and transport failures, which may have delivered the request.
      const rejectedStatus = Number(String(error).match(/\bHTTP[ :]+(4\d\d)\b/)?.[1]);
      if (mergeStarted && rejectedStatus && rejectedStatus !== 409) await pullRequestInbox.clearDirectMerge(repository, number, mergeToken);
      return await parkMerge(`GitHub merge request failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    }
    await pullRequestInbox.clearDirectMerge(repository, number, mergeToken);
    await pullRequestInbox.finish(claim, { text: `Merged ${decision.head} directly: required checks passed and review threads were resolved.`, terminal: true });
    schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: decision.head, avoided_invocation: true });
    return "merged";
  }

  const postPushGraceMs = options.postPushGraceMs ?? 3 * 60_000;

  async function parkOnPushedHead(claim: Claim, text: string, head: string, verifiedPushHeads: readonly string[], wait?: BabysitterPassResult["wait"]) {
    const current = await pullRequestInbox.get(claim.snapshot.repository, claim.snapshot.number);
    // Include this worker's verified resolutions, but leave concurrent, unseen feedback unacknowledged.
    const observed = { ...claim.snapshot, threads: claim.snapshot.threads.map(thread => {
      const latest = current?.threads.find(value => String(value.node_id ?? value.id) === String(thread.node_id ?? thread.id));
      return latest?.resolutionSource === "worker" && latest.isResolved === true
        ? { ...thread, isResolved: true, resolutionSource: latest.resolutionSource, resolutionObservedAt: latest.resolutionObservedAt } : thread;
    }) };
    let waiting = createCheckWait(observed, waitPolicy);
    if (wait?.kind === "external") {
      await pullRequestInbox.setMeta(`review-assessment:${observed.repository}#${observed.number}`, null);
      // Wake setup is best effort; an unavailable dependency must never remove the blocker.
      const allowedWake = wait.wake && options.repositories.includes(wait.wake.repository.toLowerCase()) ? wait.wake : undefined;
      waiting = { ...waiting, kind: "external", reason: wait.reason, ...(allowedWake ? { wake: allowedWake } : {}) };
      try {
        waiting = await externalWait(observed, wait.wake, wait.reason);
      } catch (error) {
        schedulerEvent("babysitter.external_wait.setup_failed", { repository: observed.repository, pull_request: observed.number,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return await pullRequestInbox.finish(claim, { text, progress: { kind: "verified", evidence: `push:${head}` }, verifiedPushHeads,
      wait: { ...waiting, headSha: head } });
  }

  /** Retries a provider rate limit three times, then blocks admission for an hour. */
  async function runWithProviderRetry<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (isAbortError(error) || !isProviderRateLimit(error)) throw error;
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

  async function requiredCheckEvaluation(snapshot: Snapshot) {
    const base = snapshot.pr?.base?.ref;
    if (!base) return undefined;
    return evaluateGitHubRequiredChecks(await requiredChecks.read(snapshot.repository, base), snapshotCheckEvidence(snapshot));
  }

  async function requiredCheckState(snapshot: Snapshot) {
    return (await requiredCheckEvaluation(snapshot))?.state ?? "unknown";
  }

  /**
   * Remembers feedback only after an explicit assessment of the unchanged head.
   * A repair push alone cannot prove that maintainer prerequisites are fulfilled.
   */
  async function recordAssessment(snapshot: Snapshot, current: { head?: string; evidenceKey?: string } = {}) {
    const key = `review-assessment:${snapshot.repository}#${snapshot.number}`;
    const previous = await pullRequestInbox.meta(key);
    const record = isRuntimeRecord(previous) && previous.version === 2 ? previous : {};
    const known = Array.isArray(record.feedback) ? record.feedback.filter(item => hasRuntimeType(item, "string")) : [];
    await pullRequestInbox.setMeta(key, {
      version: 2,
      head: current.head ?? record.head,
      evidenceKey: current.evidenceKey ?? record.evidenceKey,
      // Keep the newest identities; a long-lived PR cannot grow this record without bound.
      feedback: [...new Set([...known, ...feedbackFingerprints(snapshot, waitPolicy)])].slice(-2000),
    });
  }

  /** Why a pass waits for running gates, or undefined when it runs now. A failure or conflict always runs now. */
  async function pendingGateDeferral(snapshot: Snapshot): Promise<string | undefined> {
    if (!deferWhilePending) return undefined;
    const pr = snapshot.pr;
    if (!pr || pr.mergeable === false || pr.mergeable_state === "dirty" || failureKeys(snapshot).length) return undefined;
    if (reviewCheckRunning(snapshot, waitPolicy)) return "review checks";
    const evaluation = await requiredCheckEvaluation(snapshot);
    // A required check that never reported may never run, so only running checks defer a pass.
    return evaluation?.state === "pending" && !evaluation.missing.length ? "required checks" : undefined;
  }

  const installOption = baseAgent.install ?? presetOptions.install ?? true;
  const installer = createBabysitterInstaller(installOption);

  /**
   * Installs dependencies on the host before the provider starts, so the model spends no turns on
   * setup. Validated inputs are installed in a protected snapshot and published only on success.
   */
  async function installDependencies(cwd: string, signal: AbortSignal, owner: Record<string, unknown>, nodeOptions: string | undefined) {
    // Trusted custom commands also support workspaces without Node dependency inputs.
    const hasInputs = await Promise.all(["package.json", "pnpm-workspace.yaml"].map(name => access(join(cwd, name)).then(() => true, () => false)));
    if (isRuntimeRecord(installOption) && installOption.command && !hasInputs.some(Boolean)) {
      const record = await installer(cwd, signal, nodeOptions, hasRuntimeType(owner.repository, "string") ? owner.repository : cwd);
      if (!record) return;
      const gitDirectory = (await promisify(execFile)("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8", timeout: 5000, signal })).stdout.trim();
      await writeFile(join(gitDirectory, "vitehub-install.json"), JSON.stringify(record));
      const { output, ...timing } = record;
      schedulerEvent("babysitter.install.finished", { ...owner, ...timing });
      if (!record.ok) throw new GitHubWorkspaceInstallError(new Error(output));
      return;
    }
    await installGitHubPullRequestWorkspace(cwd, signal, async prepared => {
      const record = await installer(prepared.cwd, signal, nodeOptions, hasRuntimeType(owner.repository, "string") ? owner.repository : cwd, prepared);
      if (!record) return;
      const { output, ...timing } = record;
      schedulerEvent("babysitter.install.finished", { ...owner, ...timing });
      if (!record.ok) throw new Error(output || "Dependency installation failed.");
      return { ...timing, scripts: isRuntimeRecord(installOption) && installOption.command ? "custom" : false };
    });
  }

  /** A ready event may wake a direct merge, but must not start a model pass when
   * the user supplied merge predicate still blocks that merge. */
  async function directMergeWakeAllowed(snapshot: Snapshot, requiredChecks: Awaited<ReturnType<typeof requiredCheckState>>): Promise<boolean> {
    if (merge.mode !== "direct" || !merge.ready) return true;
    const head = snapshot.pr?.head?.sha;
    if (!head) return false;
    const callback = merge.ready;
    try {
      return await boundedMergeReady(() => callback({
        repository: snapshot.repository,
        number: snapshot.number,
        head,
        snapshot: structuredClone(snapshot),
        requiredChecks,
      })) === true;
    } catch (error) {
      schedulerEvent("babysitter.direct_merge.skipped", {
        pullRequest: snapshot.number,
        repository: snapshot.repository,
        reason: `merge readiness check failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      });
      return false;
    }
  }

  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  async function dependencyEvidence(wake: PullRequestWake): Promise<string> {
    // Dependency reads are host-owned. A parked model never polls unchanged checks.
    if (wake.kind === "pull-request") {
      const [pr] = await readRest(`repos/${wake.repository}/pulls/${wake.number}`, ".");
      if (!isRuntimeRecord(pr)) throw new Error("Missing external pull-request state.");
      return digest({ state: pr.state, mergedAt: pr.merged_at, head: isRuntimeRecord(pr.head) ? pr.head.sha : undefined });
    }
    return await checksDependencyEvidence(wake, (path, projection) => readRest(path, projection));
  }
  async function externalWait(observed: Snapshot, wake: PullRequestWake | undefined, reason: string) {
    if (!wake) await statusRecovery.recordWorkerBlocker(observed, reason);
    if (!wake) return { ...createCheckWait(observed, waitPolicy), kind: "external" as const, reason };
    if (!options.repositories.includes(wake.repository.toLowerCase())) throw new Error("External wake repository is outside the configured repositories.");
    const evidence = await dependencyEvidence(wake);
    await pullRequestInbox.setMeta(`dependency:${observed.repository}#${observed.number}`, evidence);
    return { ...createCheckWait(observed, waitPolicy), kind: "external" as const, reason, wake };
  }

  async function recoverFailedCiWaits() {
    for (const snapshot of await pullRequestInbox.waitsToEvaluate(false, true)) {
      if (snapshot.generation > snapshot.handled || isWorkerBlocker(snapshot) || !hasFailedActions(snapshot)) continue;
      const head = snapshot.pr?.head?.sha;
      if (!head) continue;
      const recoveryKey = `ci-recovery-next:${snapshot.repository}#${snapshot.number}:${head}`;
      if ((await pullRequestInbox.metaNumber(recoveryKey) ?? 0) > Date.now()) continue;
      await pullRequestInbox.setMeta(recoveryKey, Date.now() + 10 * 60_000);
      if (await pullRequestInbox.wake(snapshot, `ci-recovery:${head}`, { recovery: true })) {
        schedulerEvent("babysitter.ci.recovery.woken", { repository: snapshot.repository, pull_request: snapshot.number, head_sha: head });
      }
    }
  }

  /** Wakes a parked PR only when its new events need a model pass or a direct merge. */
  async function evaluateWaits() {
    for (const snapshot of await pullRequestInbox.waitsToEvaluate(true)) {
      if (snapshot.generation <= snapshot.handled && (snapshot.wait?.retryAt ?? Infinity) > Date.now() && !snapshot.wait?.wake) continue;
      const checks = await requiredCheckState(snapshot);
      let reasons = wakeReasons(snapshot, checks, waitPolicy);
      if (reasons.includes("ready-to-merge") && !(await directMergeWakeAllowed(snapshot, checks))) {
        reasons = reasons.filter(reason => reason !== "ready-to-merge");
      }
      if (snapshot.wait?.retryAt !== undefined && snapshot.wait.retryAt <= Date.now()) reasons.push("merge-retry");
      if (snapshot.wait?.wake) {
        const dependencyKey = `dependency:${snapshot.repository}#${snapshot.number}`;
        const nextReadKey = `dependency-next:${snapshot.repository}#${snapshot.number}`;
        if (((await pullRequestInbox.metaNumber(nextReadKey)) ?? 0) <= Date.now()) {
          await pullRequestInbox.setMeta(nextReadKey, Date.now() + 60_000);
          const next = await dependencyEvidence(snapshot.wait.wake);
          if (next !== await pullRequestInbox.meta(dependencyKey)) reasons.push("external-dependency-changed");
        }
      }
      const owner = { pullRequest: snapshot.number, repository: snapshot.repository };
      if (!reasons.length) {
        await pullRequestInbox.acknowledgeWait(snapshot);
        schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: snapshot.pr?.head?.sha, avoided_invocation: true });
      } else if (await pullRequestInbox.wake(snapshot, `evaluated:${snapshot.generation}:${snapshot.revision ?? 0}`)) {
        schedulerEvent("babysitter.wait.woken", { ...owner, head_sha: snapshot.pr?.head?.sha, reasons });
      }
    }
  }

  /** Moves a stacked PR to the default branch after its parent merged there. */
  async function retargetMergedStackBase(claim: Claim, signal: AbortSignal): Promise<{ from: string; to: string } | { parent: number } | undefined> {
    const snapshot = claim.snapshot;
    const pr = snapshot.pr;
    const target = pr && nonDefaultBase(pr);
    if (!pr || !target) return undefined;
    const { base, owner } = target;
    const parents = await readRest(`repos/${snapshot.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=10`, undefined, signal);
    const to = stackRetargetBase(pr, parents);
    if (!to) {
      const parent = parents.find(value => isRuntimeRecord(value) && String(value.state).toLowerCase() === "open" && Number.isSafeInteger(value.number));
      return isRuntimeRecord(parent) && hasRuntimeType(parent.number, "number") ? { parent: parent.number } : undefined;
    }
    const [live] = await readRest(`repos/${snapshot.repository}/pulls/${snapshot.number}`, ".", signal);
    if (!isRuntimeRecord(live) || String(live.state).toLowerCase() !== "open"
      || !isRuntimeRecord(live.base) || live.base.ref !== base
      || !isRuntimeRecord(live.head) || live.head.sha !== pr.head?.sha
      || !await pullRequestInbox.isClaimCurrent(claim)) {
      await pullRequestInbox.hydrate(claim, { refresh: true });
      throw new DOMException("Stack child changed before retargeting.", "AbortError");
    }
    signal.throwIfAborted();
    try {
      await github.command(["api", "-X", "PATCH", `repos/${snapshot.repository}/pulls/${snapshot.number}`, "-f", `base=${to}`], { repository: snapshot.repository, timeout: 60_000, signal });
    } catch (error) {
      // A stale stack snapshot can race a webhook or another worker. GitHub
      // may reject a redundant retarget even though the desired base is live.
      const [current] = await readRest(`repos/${snapshot.repository}/pulls/${snapshot.number}`, ".", signal);
      const currentBase = isRuntimeRecord(current) && isRuntimeRecord(current.base) ? current.base.ref : undefined;
      if (currentBase !== to) throw error;
    }
    return { from: base, to };
  }

  function workload() {
    return { running: active.size };
  }

  // PRs that a paused admission already checked for host-only work, by generation and revision.
  // They stay unclaimed until their evidence changes.
  const hostOnlyChecked = new Map<string, string>();
  const hostOnlyStamp = (s: Snapshot) => `${s.generation}:${s.revision ?? 0}`;

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
    await statusRecovery.recover();
    void track(statusRecovery.flush().catch(failure => schedulerError("babysitter.status.flush.failed", failure)));
    let modelAdmission = true;
    let modelRetryAt: number | undefined;
    if (options.admission) {
      const admission = await options.admission();
      if (!admission.accepting) {
        modelAdmission = false;
        modelRetryAt = admission.retryAt ?? Date.now() + 60_000;
        // SAFETY: This metadata key is only written by this admission branch with the fields below; absent or unrelated values are ignored.
        const previous = await pullRequestInbox.meta("admission-skipped") as { reason?: string; at?: number } | undefined;
        if (previous?.reason !== admission.reason || Date.now() - (previous?.at ?? 0) >= 900_000) {
          const skipped = { at: Date.now(), reason: admission.reason, detail: admission.detail, retryAt: admission.retryAt, active_owners: active.size };
          await pullRequestInbox.setMeta("admission-skipped", skipped);
          schedulerEvent("babysitter.admission.skipped", { trigger: reason, ...skipped });
        }
        if (!admission.hostOnly) return;
      }
    }
    const ownerLimit = options.concurrency;
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
      // One open-PR query per repository and minute finds lost deliveries; only changed PRs are probed.
      await detectChangedPullRequests(pullRequestInbox, repository => readGraphql(repository, 4), repositories, Date.now(), !eventScopedBootstrap);
    } catch (error) {
      schedulerError("babysitter.snapshot.detect.failed", error);
    }
    try {
      await probeChangedSnapshots(pullRequestInbox, readRest, Date.now(), readThreads, activityAuthors);
      // The slow sweep remains for changes the fingerprint cannot see, such as edited comments.
      await reconcileOneSnapshot(pullRequestInbox, readRest, Date.now(), readThreads, activityAuthors);
    } catch (error) {
      schedulerError("babysitter.snapshot.reconcile.failed", error);
    }
    // Recover leases that expired while the host was stopped before claiming work.
    await pullRequestInbox.recoverLeases();
    try {
      if ((await pullRequestInbox.metaNumber("idle-wait-sweep-next") ?? 0) <= Date.now()) {
        await pullRequestInbox.setMeta("idle-wait-sweep-next", Date.now() + 10 * 60_000);
        await recoverFailedCiWaits();
      }
      await evaluateWaits();
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
    const remainingCapacity = Math.max(0, ownerLimit + (modelAdmission ? 0 : 5) - active.size);
    const lane = await pullRequestInbox.claim(Math.min(5, remainingCapacity), {
      only: snapshot => Boolean(snapshot.recoveryHead && snapshot.recoveryHead === snapshot.pr?.head?.sha),
      includeBlocked: true,
      skip: snapshot => !modelAdmission && hostOnlyChecked.get(`${snapshot.repository}#${snapshot.number}`) === hostOnlyStamp(snapshot),
    });
    // Admission limits model dispatch. Merges and stack retargets remain host work.
    const regular = await pullRequestInbox.claim(Math.max(0, remainingCapacity - lane.length), { skip: snapshot => !modelAdmission && hostOnlyChecked.get(`${snapshot.repository}#${snapshot.number}`) === hostOnlyStamp(snapshot) });
    const jobs = [...lane, ...regular];
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
        inboxClaim.runId = runId;
        inboxClaim.startedAt = startedAt;
        let outcome = "completed";
        let disposition: BabysitterPassResult["disposition"] | undefined;
        let resultText = "";
        let passResult: BabysitterPassResult | undefined;
        let pushSucceeded = false;
        let pushedHead: string | undefined;
        const verifiedPushHeads = new Set<string>();
        let pushedAt: ReturnType<typeof setTimeout> | undefined;
        schedulerEvent("babysitter.owner.started", { maxOwners: ownerLimit, ...owner });
        const passController = new AbortController();
        const passSignal = AbortSignal.any([
          AbortSignal.timeout(60 * 60 * 1000),
          passController.signal,
        ]);
        let providerDirectory: string | undefined;
        let modelWorkParked = false;
        const parkBlockedModelWork = async () => {
          const currentAdmission = await options.admission?.();
          const retryAt = currentAdmission && !currentAdmission.accepting
            ? currentAdmission.retryAt ?? Date.now() + 60_000 : modelRetryAt;
          const providerBlockedUntil = (await pullRequestInbox.metaNumber("provider-quota-blocked-until")) ?? 0;
          const providerBlocked = providerBlockedUntil > Date.now();
          const admitted = (currentAdmission?.accepting ?? modelAdmission) && !providerBlocked;
          if (babysitterModelAdmission(admitted, inboxClaim.snapshot)) return false;
          modelWorkParked = true;
          outcome = "waiting";
          await pullRequestInbox.finish(inboxClaim, {
            text: providerBlocked
              ? `CI reconciliation completed; provider quota cooldown ends at ${new Date(providerBlockedUntil).toISOString()}.`
              : admitted
                ? "CI reconciliation completed; the same-head repair budget is exhausted."
                : "CI reconciliation completed; model work is waiting for host admission.",
            ...(pushedHead ? { progress: { kind: "verified" as const, evidence: `push:${pushedHead}` }, verifiedPushHeads: [...verifiedPushHeads] } : {}),
            wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy),
              ...(pushedHead ? { headSha: pushedHead } : {}),
              retryAt: admitted ? undefined : Math.max(retryAt ?? 0, providerBlocked ? providerBlockedUntil : 0) },
          });
          return true;
        };
        const preparedDirectories = new Set<string>();
        const stopPullRequestWatch = cancelWhenPullRequestStops(
          inboxClaim,
          passController,
          () => providerDirectory,
          () => pushedHead,
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
          if (!pullRequestInbox.eligible(repository, inboxClaim.snapshot.pr)) {
            await pullRequestInbox.finish(inboxClaim, {
              text: "PR closed or outside the configured filter.",
              terminal: true,
            });
            return;
          }
          const retargeted = await retargetMergedStackBase(inboxClaim, passSignal);
          if (retargeted && "parent" in retargeted) {
            await pullRequestInbox.finish(inboxClaim, { text: `Waiting for open parent PR #${retargeted.parent} before repairing its child.`,
              wait: await externalWait(inboxClaim.snapshot, { kind: "pull-request", repository, number: retargeted.parent }, "stack-parent") });
            schedulerEvent("babysitter.stack.waiting", { ...owner, parent: retargeted.parent });
            return;
          }
          if (retargeted) {
            // GitHub sends an edited event for the new base; that event wakes the next pass.
            await pullRequestInbox.finish(inboxClaim, { text: `Retargeted from ${retargeted.from} to ${retargeted.to} after the parent pull request merged.` });
            schedulerEvent("babysitter.stack.retargeted", { ...owner, ...retargeted });
            return;
          }
          if (merge.mode === "direct") {
            const mergeResult = await mergeReadyPullRequest(inboxClaim, owner, passSignal);
            if (mergeResult !== "not-ready") return;
            // A previous pass explicitly reviewed this unchanged head. If the
            // merge gates are still closed, keep waiting instead of invoking
            // the model again. New feedback, conflicts, or a new failure alter
            // the evidence key and invalidate this checkpoint.
            const assessment = await pullRequestInbox.meta(`review-assessment:${repository}#${number}`);
            if (isRuntimeRecord(assessment)
              && assessment.version === 2
              && assessment.head === inboxClaim.snapshot.pr?.head?.sha
              && assessment.evidenceKey === mergeReviewEvidenceKey(inboxClaim.snapshot, waitPolicy)
              && inboxClaim.snapshot.threads.every(thread => thread.isResolved === true)
              && inboxClaim.snapshot.pr?.mergeable !== false
              && inboxClaim.snapshot.pr?.mergeable_state !== "dirty") {
              await pullRequestInbox.finish(inboxClaim, {
                text: inboxClaim.snapshot.lastResult || "Reviewed head is unchanged; waiting for merge gates.",
                wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), retryAt: Date.now() + 120_000 },
              });
              schedulerEvent("babysitter.wait.kept", {
                ...owner,
                head_sha: inboxClaim.snapshot.pr?.head?.sha,
                avoided_invocation: true,
                reason: "reviewed-head-unchanged",
              });
              return;
            }
          }
          const deferral = await pendingGateDeferral(inboxClaim.snapshot);
          if (deferral) {
            // Running gates finish soon. One later pass then handles their results and the feedback together.
            await pullRequestInbox.finish(inboxClaim, {
              text: inboxClaim.snapshot.lastResult || `Waiting for ${deferral} before the next pass.`,
              wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), defer: "checks" },
            });
            outcome = "waiting";
            schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, avoided_invocation: true, reason: `deferred:${deferral}` });
            return;
          }
          if (!modelAdmission && inboxClaim.snapshot.recoveryHead !== inboxClaim.snapshot.pr?.head?.sha) {
            // The PR needs a model pass. Leave it queued unchanged until admission reopens.
            await pullRequestInbox.release(inboxClaim);
            const released = await pullRequestInbox.get(repository, number);
            if (released) hostOnlyChecked.set(`${repository}#${number}`, hostOnlyStamp(released));
            outcome = "admission-paused";
            return;
          }
          if (!(await hydrateFailedCiEvidence(pullRequestInbox, inboxClaim, {
            readJson: (path, projection) => readRest(path, projection, passSignal),
            readLog: async (path, repository) => (await github.command(["api", path], { repository, timeout: 60_000, signal: passSignal })).stdout,
          }))) { await pullRequestInbox.release(inboxClaim); return; }
          const ciRecovery = await rerunFailedActions(
            pullRequestInbox,
            inboxClaim,
            (args, request) => github.command(args, { ...request, signal: passSignal }),
          );
          if (inboxClaim.snapshot.recoveryHead && inboxClaim.snapshot.recoveryHead === inboxClaim.snapshot.pr?.head?.sha && !hasFailedActions(inboxClaim.snapshot)) {
            outcome = "waiting";
            const wait = createCheckWait(inboxClaim.snapshot, waitPolicy);
            if (merge.mode === "direct") wait.retryAt = Date.now() + 120_000;
            await pullRequestInbox.finish(inboxClaim, { text: "Recovered CI is healthy; waiting for merge gate evaluation.", wait });
            return;
          }
          if (ciRecovery?.state === "rerun") {
            outcome = "waiting";
            await pullRequestInbox.finish(inboxClaim, {
              text: `Automatically reran failed GitHub Actions run${ciRecovery.runs.length === 1 ? "" : "s"} ${ciRecovery.runs.map(run => run.runId).join(", ")}; waiting for the new check result.`,
              wait: createCheckWait(inboxClaim.snapshot, waitPolicy),
            });
            schedulerEvent("babysitter.ci.rerun", { ...owner, runs: ciRecovery.runs.map(run => run.runId) });
            return;
          }
          const permissionFallback = await pullRequestInbox.meta(`ci-permission-fallback:v1:${inboxClaim.snapshot.repository}:${inboxClaim.snapshot.pr?.head?.sha ?? ""}`);
          const fallbackEvidenceKey = mergeReviewEvidenceKey(inboxClaim.snapshot, waitPolicy);
          if (ciRecovery?.state === "blocked" && (!ciRecovery.permission || isRuntimeRecord(permissionFallback) && permissionFallback.consumedAt && permissionFallback.evidenceKey === fallbackEvidenceKey)) {
            outcome = "waiting";
            await pullRequestInbox.finish(inboxClaim, {
              text: `Automatic GitHub Actions rerun is blocked: ${ciRecovery.reason}`,
              wait: ciRecovery.permission
                ? { ...createCheckWait(inboxClaim.snapshot, waitPolicy), kind: "external", reason: ciRecovery.reason }
                : { ...createCheckWait(inboxClaim.snapshot, waitPolicy), retryAt: Date.now() + 120_000 },
            });
            schedulerEvent("babysitter.ci.rerun.blocked", { ...owner, reason: ciRecovery.reason });
            return;
          }
          if (ciRecovery?.state === "waiting") {
            outcome = "waiting";
            await pullRequestInbox.finish(inboxClaim, {
              text: `Automatic GitHub Actions rerun already attempted; waiting for the new check result${ciRecovery.reason ? `: ${ciRecovery.reason}` : "."}`,
              wait: createCheckWait(inboxClaim.snapshot, waitPolicy),
            });
            schedulerEvent("babysitter.ci.rerun.waiting", { ...owner, reason: ciRecovery.reason });
            return;
          }
          if (inboxClaim.snapshot.pr?.mergeable === null || inboxClaim.snapshot.pr?.mergeable_state === "unknown") {
            const reason = "GitHub is still calculating mergeability for this PR head.";
            await pullRequestInbox.finish(inboxClaim, { text: reason,
              wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), kind: "external", reason, retryAt: Date.now() + 30_000 } });
            schedulerEvent("babysitter.mergeability.waiting", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha });
            return;
          }
          if (await parkBlockedModelWork()) return;
          if (ciRecovery?.state === "blocked" && ciRecovery.permission) {
            await pullRequestInbox.setMeta(`ci-permission-fallback:v1:${inboxClaim.snapshot.repository}:${inboxClaim.snapshot.pr?.head?.sha ?? ""}`, { pendingAt: Date.now() });
          }
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
              const repairOperation = new AsyncLocalStorage<boolean>();
              const ownedResolutions = new Map<string, number>();
              const repairEvidenceKey = (snapshot: Snapshot, current = snapshot) => {
                const published = !!pushedHead && verifiedPushHeads.has(pushedHead);
                const original = published && snapshot === inboxClaim.snapshot;
                const checks: Snapshot["checks"] = original ? {} : Object.fromEntries(Object.entries(snapshot.checks).filter(([key]) =>
                  !["success", "neutral", "skipped"].includes(String(current.checks[key]?.conclusion).toLowerCase())
                  && (!published || verifiedPushHeads.has(snapshot.checks[key]?.head_sha ?? ""))));
                const statuses: Snapshot["statuses"] = original ? {} : Object.fromEntries(Object.entries(snapshot.statuses).filter(([key]) =>
                  String(current.statuses[key]?.state).toLowerCase() !== "success"
                  && (!published || verifiedPushHeads.has(snapshot.statuses[key]?.sha ?? ""))));
                if (published) {
                  for (const key of Object.keys(checks)) checks[key] = { ...checks[key], head_sha: pullRequest.headRefOid };
                  for (const key of Object.keys(statuses)) statuses[key] = { ...statuses[key], sha: pullRequest.headRefOid };
                }
                // A self-push replaces old-head checks, but fresh failures and
                // feedback still revoke further publication on every owned head.
                return mergeReviewEvidenceKey({ ...snapshot, checks, statuses,
                  threads: snapshot.threads.map(thread => ownedResolutions.has(String(thread.node_id ?? thread.id))
                    ? { ...thread, isResolved: true } : thread),
                  pr: snapshot.pr && { ...snapshot.pr,
                    head: snapshot.pr.head && { ...snapshot.pr.head, sha: published ? pullRequest.headRefOid : snapshot.pr.head.sha },
                    base: snapshot.pr.base && { ...snapshot.pr.base, sha: undefined } },
                }, waitPolicy);
              };
              let observePendingPush: ((current: Snapshot) => void) | undefined;
              const pendingInboxHeads = new Set([pullRequest.headRefOid]);
              const assertLease = async () => {
                abortSignal.throwIfAborted();
                const current = await pullRequestInbox.get(repository, number);
                if (current?.lease !== inboxClaim.token || current.leaseUntil <= Date.now()) {
                  throw new DOMException("Pull request lease lost.", "AbortError");
                }
                observePendingPush?.(current);
                for (const [id, reopens] of ownedResolutions) {
                  if ((current.threadReopens?.[id] ?? 0) !== reopens) throw new DOMException("An addressed review thread was reopened.", "AbortError");
                }
                const observedHead = current.pr?.head?.sha;
                if (current.sourcePushOverflow || current.sourcePushHeads?.some(head => !verifiedPushHeads.has(head)) || current.sourcePushHead !== inboxClaim.snapshot.sourcePushHead && !verifiedPushHeads.has(current.sourcePushHead ?? "")) {
                  throw new DOMException("Pull request source branch changed before synchronize.", "AbortError");
                }
                const stopped = claimStopReason(inboxClaim, current, observedHead && pendingInboxHeads.has(observedHead) ? observedHead : pushedHead);
                if (stopped) throw new DOMException(stopped, "AbortError");
                if (pushedHead && observedHead === pushedHead) {
                  pendingInboxHeads.clear(); pendingInboxHeads.add(pushedHead);
                }
                // Merge and feedback mutations require the original generation.
                // Repair publication may coalesce base and successful-check updates
                // when its head, requirements and actionable feedback are unchanged.
                const selfHead = observedHead !== pullRequest.headRefOid && verifiedPushHeads.has(observedHead ?? "");
                if (current.generation !== inboxClaim.generation
                  && !((selfHead || repairOperation.getStore()) && repairEvidenceKey(current) === repairEvidenceKey(inboxClaim.snapshot, current))) {
                  throw new DOMException("Pull request evidence changed.", "AbortError");
                }
                return current;
              };
              let preparedMergeBase: string | undefined;
              const readRepairBase = async () => {
                // PR snapshots can retain an older base after its branch moves.
                // Conflict preparation must merge the current target branch.
                const [ref] = await readRest(`repos/${repository}/git/ref/heads/${encodeURIComponent(pullRequest.baseRefName)}`, ".", abortSignal);
                if (!isRuntimeRecord(ref) || ref.ref !== `refs/heads/${pullRequest.baseRefName}` || !isRuntimeRecord(ref.object)
                  || ref.object.type !== "commit" || !hasRuntimeType(ref.object.sha, "string") || !/^[a-f\d]{40}$/i.test(ref.object.sha)) {
                  throw new Error("Conflict repair requires the exact live base branch commit.");
                }
                return ref.object.sha;
              };
              const assertRepairBase = async () => {
                if (!preparedMergeBase) return;
                const [live] = await readRest(`repos/${repository}/pulls/${number}`, ".", abortSignal);
                if (!isRuntimeRecord(live) || !isRuntimeRecord(live.base) || live.base.ref !== pullRequest.baseRefName || await readRepairBase() !== preparedMergeBase) {
                  await pullRequestInbox.hydrate(inboxClaim, { refresh: true });
                  const changed = new DOMException("Pull request base changed; retry the conflict repair against current GitHub state.", "AbortError");
                  passController.abort(changed);
                  throw changed;
                }
              };
              const prepareRepairWorkspace = async (directory: string, nodeOptions?: string) => {
                if (!preparedDirectories.has(directory)) {
                  if (directory !== checkout) await prepared.prepareWorkspace(directory, { restoreInstructions: true });
                  if (webhookSnapshot.pr?.mergeable === false || webhookSnapshot.pr?.mergeable_state === "dirty") {
                    const base = await readRepairBase();
                    await prepareGitHubRepairBase(directory, { expectedHead: pullRequest.headRefOid, base, signal: abortSignal, fetch: { url: `https://github.com/${repository}.git`, env: prepared.env } });
                    preparedMergeBase = base;
                  }
                  if (presetOptions.install !== false) {
                    // Dependency conflicts must be resolved before the explicit refresh tool can install.
                    try { await installDependencies(directory, abortSignal, owner, nodeOptions); }
                    catch (error) { if (!preparedMergeBase || abortSignal.aborted || !(error instanceof GitHubWorkspaceInstallError) || !(error.cause instanceof GitHubDependencyConflictError)) throw error; }
                  }
                  preparedDirectories.add(directory);
                }
              };
              const operationHost: Pick<GitHubHost, "command" | "ensureGraphQLBudget"> = {
                command: async (args, request) => {
                  await assertLease();
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
                // Launch preparation may replace the stale snapshot base before the tools run.
                get expectedBaseOid() { return preparedMergeBase ?? pullRequest.baseRefOid; },
                mentionAllowlist: presetOptions.mentionAllowlist,
                restrictCommentMentions: true,
                // Mark every repair comment, including mentions, so its webhook cannot revoke this pass.
                commentPrefix: "<!-- vitehub-babysitter-repair:repair -->\n",
                signal: abortSignal,
                autoMerge: merge.mode === "auto",
                eligible: (current) =>
                  pullRequestInbox.eligible(repository, normalizePullRequest(current)),
                refreshDependencies: async () => {
                  if (!providerDirectory) throw new Error("The repair workspace is not prepared.");
                  await assertLease();
                  await assertRepairBase();
                  if (presetOptions.install !== false) await installDependencies(providerDirectory, abortSignal, owner, undefined);
                  await assertLease();
                },
                commitRepair: async (input) => {
                  if (!providerDirectory) throw new Error("The repair workspace is not prepared.");
                  await assertLease();
                  await assertRepairBase();
                  if (presetOptions.install !== false) await assertGitHubDependenciesCurrent(providerDirectory);
                  const head = await prepared.commitRepair(providerDirectory, input, { verifyDependencies: presetOptions.install !== false });
                  await assertLease();
                  return head;
                },
                push: async () => {
                  if (!providerDirectory) throw new Error("The repair workspace is not prepared.");
                  await assertLease();
                  await assertRepairBase();
                  const renewLease = async () => {
                    let current = await assertLease();
                    for (;;) {
                      if (await pullRequestInbox.renew({ ...inboxClaim, generation: current.generation, snapshot: current }, Date.now() + 2 * 60 * 60_000)) return;
                      // A generation can advance between validation and CAS.
                      // Recheck ownership, head and feedback before adopting it.
                      const latest = await assertLease();
                      if (latest.generation === current.generation) throw new DOMException("Pull request lease renewal failed.", "AbortError");
                      current = latest;
                    }
                  };
                  let renewing = false;
                  const renew = setInterval(() => {
                    if (renewing) return;
                    renewing = true;
                    void renewLease().catch(() => passController.abort()).finally(() => { renewing = false; });
                  }, 30_000);
                  const recordPush = (head: string) => {
                    // A no-op push creates no synchronize webhook or repair progress.
                    pushSucceeded = head !== pullRequest.headRefOid;
                    if (pushSucceeded) {
                      if (pushedHead !== head) {
                        verifiedPushHeads.add(head);
                        pendingInboxHeads.add(head);
                        pushedHead = head;
                      }
                      pushedAt ??= setTimeout(() => passController.abort(new DOMException("Repair pushed; waiting for check and review webhooks.", "TimeoutError")), postPushGraceMs);
                    }
                  };
                  try {
                    const result = await prepared.push(providerDirectory, {
                      signal: abortSignal,
                      beforePush: async head => {
                        const current = await assertLease(); await assertRepairBase();
                        if (head && !await pullRequestInbox.registerProspectivePush({ ...inboxClaim, generation: current.generation, snapshot: current }, head)) {
                          throw new DOMException("Publication candidate lease changed.", "AbortError");
                        }
                        // The host supplies its exact validated local Git head.
                        // A signed source webhook can confirm publication before
                        // the local push subprocess returns its receipt.
                        observePendingPush = head ? current => {
                          if (current.sourcePushHeads?.includes(head)) recordPush(head);
                        } : undefined;
                      },
                      // The synchronize webhook may still expose the pre-push head.
                      afterPush: async head => { recordPush(head); await assertLease(); },
                    });
                    recordPush(result);
                    return result;
                  } finally {
                    observePendingPush = undefined;
                    clearInterval(renew);
                  }
                },
              });
              const resolveThread = operations.resolveThread;
              operations.resolveThread = id => repairOperation.run(true, async () => {
                const current = await assertLease();
                const reopens = current.threadReopens?.[id] ?? 0;
                await resolveThread(id);
                await pullRequestInbox.recordThreadResolution(inboxClaim, id, current);
                // Record only a successful, PR-owned resolution. New comments
                // remain in the evidence hash; any external reopen revokes it.
                ownedResolutions.set(id, reopens);
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
              const workerName = `${options.agentName ?? baseAgent.name ?? "babysitter"}-worker`;
              const baseSettings = getAgentLayerOptions(baseAgent);
              if (!baseSettings) throw new Error("Babysitter base Agent settings are unavailable.");
              // Build the worker from the base settings while replacing only
              // its GitHub Channel. Extending the base Agent would preserve
              // the host identity, but dropping the whole map loses other
              // channel-scoped capabilities needed by repair passes.
              const { channels: _baseChannels, github: _baseGitHub, workspace: configuredWorkspace, ...workerSettings } = baseSettings;
              if (workerSettings.box) providerDirectory = checkout;
              const baseChannels = isRuntimeRecord(_baseChannels) ? _baseChannels : {};
              const workerBaseChannels = Object.fromEntries(Object.entries(baseChannels).map(([name, channel]) => {
                if (!isRuntimeRecord(channel) || channel.kind !== "github") return [name, channel];
                const sanitized = { ...channel };
                // A GitHub channel under any key can otherwise reintroduce host credentials.
                Reflect.deleteProperty(sanitized, Symbol.for("vitehub.githubChannelIdentity"));
                return [name, sanitized];
              }));
              const baseCapabilities = workerSettings.capabilities;
              const repair = repairCapability(operations, merge.mode === "auto", presetOptions.mentionAllowlist, async (context) => {
                if (!workerSettings.box) return;
                const session = activeProviderBox(context);
                if (!session) throw new Error("The repair Box is not prepared.");
                await assertLease();
                if (!session.localWorkspace) await importBoxCommit(session.session, checkout, pullRequest.headRefOid, abortSignal);
              }, {
                runRepair: execute => repairOperation.run(true, execute),
                beforeRepair: async (context, paths) => {
                  if (!workerSettings.box) return;
                  await assertLease();
                  await assertRepairBase();
                  const box = activeProviderBox(context);
                  if (!box) throw new Error("The repair Box is not prepared.");
                  if (!box.localWorkspace) {
                    await importBoxCommit(box.session, checkout, pullRequest.headRefOid, abortSignal);
                    if (paths) await importBoxRepairFiles(box.session, checkout, paths, abortSignal);
                    else await importBoxRepairWorkspace(box.session, checkout, abortSignal);
                  }
                  await assertLease();
                },
                afterRefresh: async context => {
                  if (!workerSettings.box || presetOptions.install === false) return;
                  await assertLease();
                  const box = activeProviderBox(context);
                  if (!box) throw new Error("The repair Box is not prepared.");
                  if (!box.localWorkspace) await publishBoxDependencies(box.session, checkout, abortSignal);
                  await assertLease();
                },
              });
              // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability inputs accept either a static list or resolver function at this runtime boundary.
              const workerCapabilities = typeof baseCapabilities === "function"
                ? async (context: Parameters<AgentCapabilitiesResolver>[0]) => [
                  ...(await resolveAgentCapabilityDefinitions(baseCapabilities, context)).filter(capability => capability.id !== "babysitter.github"),
                  repair,
                ]
                : [
                  ...(Array.isArray(baseCapabilities) ? baseCapabilities : []).filter(capability => capability.id !== "babysitter.github"),
                  repair,
                ];
              copyDefinitionDecorations(asMetadataTarget(baseAgent), asMetadataTarget(workerSettings));
              const workerChannel = { ...github.channel({
                activity: activityEnabled,
                pullRequest: { filter: presetOptions.filter, workspace: false },
              }) };
              // Preserve host-owned activity and delivery closures without
              // exposing their identity to provider credential resolution.
              Reflect.deleteProperty(workerChannel, Symbol.for("vitehub.githubChannelIdentity"));
              // Keep the base Agent's configured Workspace sources, loaders, and
              // instruction bindings while replacing the checkout-owned fields.
              let baseWorkspace: Record<string, unknown> = {};
              if (hasRuntimeType(configuredWorkspace, "string")) {
                baseWorkspace = { ...await resolveRegisteredWorkspaceDefinition(configuredWorkspace) };
              }
              else if (isRuntimeRecord(configuredWorkspace)) {
                const workspaceName = hasRuntimeType(configuredWorkspace.name, "string") ? configuredWorkspace.name : undefined;
                const registeredWorkspace = workspaceName
                  ? await resolveRegisteredWorkspaceDefinition(workspaceName)
                  : undefined;
                baseWorkspace = {
                  ...(registeredWorkspace ?? {}),
                  ...configuredWorkspace,
                };
              }
              // Named Workspace references cannot be combined with owned fields.
              // The checkout below replaces the reference with its prepared workspace.
              Reflect.deleteProperty(baseWorkspace, "name");
              const workerOptions = {
                ...workerSettings,
                name: workerName,
                // GitHub authority stays in the broker operations above;
                // attaching the host here would expose its token to the driver.
                channels: {
                  ...workerBaseChannels,
                  github: workerChannel,
                },
                // SAFETY: workerCapabilities preserves validated base capability definitions and appends the broker capability.
                capabilities: workerCapabilities as never,
                driver: {
                  ...workerDriver,
                  // Match the preset: unattended passes cannot escalate native
                  // permissions. Repair tools remain authorized by the host.
                  permissions: "allow-edits-unattended" as const,
                  env: async (context: AgentProviderCredentialContext) => {
                    const environment =
                      workerDriver.env === undefined
                        ? undefined
                        : await resolveRuntimeValue(workerDriver.env, context);
                    return repairEnvironment(environment, join(checkout, ".vitehub-github-auth"), prepared.env);
                  },
                  ...(workerSettings.box ? undefined : { launch: async (context: AgentProviderLaunchContext) => {
                    if (context.purpose !== "inspection") {
                      await prepareRepairWorkspace(context.cwd, hasRuntimeType(context.environment.NODE_OPTIONS, "string") ? context.environment.NODE_OPTIONS : undefined);
                      providerDirectory = context.cwd;
                    }
                    const launch = workerDriver.launch
                      ? await resolveRuntimeValue(workerDriver.launch, context)
                      : { command: context.command };
                    // Workspace setup and a custom launch can outlive another
                    // owner's quota failure. Recheck before starting the provider.
                    if (await parkBlockedModelWork()) throw new DOMException("Provider dispatch is waiting for admission.", "AbortError");
                    return launch;
                  } }),
                },
              };
              if (workerSettings.box) {
                // Box runtimes copy the host cwd when they open. Prepare the
                // exact merge and installed graph before that copy is taken.
                await prepareRepairWorkspace(checkout);
                if (await parkBlockedModelWork()) throw new DOMException("Provider dispatch is waiting for admission.", "AbortError");
              }
              const agent = workerSettings.box
                ? defineAgent({ ...workerOptions, box: { ...workerSettings.box, checkout: undefined, cwd: checkout, requires: [...(workerSettings.box.requires ?? []), "git"] } })
                : defineAgent({ ...workerOptions, workspace: {
                    ...baseWorkspace,
                    commit: false,
                    mode: "write",
                    store: { provider: "local", root: checkout, locks: "process" },
                  } });
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
              inboxClaim.activity = githubRun.activity;
              const result = await runWithProviderRetry(async () => {
                // Run metadata and retry backoff can outlive a sibling admission
                // block. Check each Box dispatch immediately before runAgent.
                if (workerSettings.box && await parkBlockedModelWork()) throw new DOMException("Provider dispatch is waiting for admission.", "AbortError");
                return await runAgent(
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
                );
              }, abortSignal);
              const validated = babysitterPassResultSchema["~standard"].validate(result);
              if ("issues" in validated)
                throw new Error("Babysitter returned an invalid pass result.");
              passResult = validated.value;
              disposition = validated.value.disposition;
              resultText = validated.value.text;
            },
            { signal: passSignal, timeout: 60 * 60 * 1000 },
          );

          if (modelWorkParked) return;

          const current = await pullRequestInbox.get(repository, number);
          const assessed = passResult?.wait?.kind !== "external" && !pushedHead && disposition === "park" && passResult?.reviewedHead === pullRequest.headRefOid
            && current?.pr?.head?.sha === pullRequest.headRefOid && await pullRequestInbox.isClaimCurrent(inboxClaim);
          if (assessed) await recordAssessment(inboxClaim.snapshot, { head: pullRequest.headRefOid, evidenceKey: mergeReviewEvidenceKey(inboxClaim.snapshot, waitPolicy) });
          let recorded = false;
          const terminal = current?.status === "terminal";
          if (terminal) {
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, terminal: true });
          } else if (pushedHead) {
            outcome = "waiting";
            recorded = await parkOnPushedHead(inboxClaim, resultText, pushedHead, [...verifiedPushHeads], passResult?.wait);
          } else if (disposition === "park" && current?.pr?.head?.sha === pullRequest.headRefOid && passResult?.wait?.kind === "external") {
            outcome = "waiting";
            await pullRequestInbox.setMeta(`review-assessment:${repository}#${number}`, null);
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText,
              wait: await externalWait(inboxClaim.snapshot, passResult.wait.wake, passResult.wait.reason) });
          } else if (disposition === "park" && current?.pr?.head?.sha === pullRequest.headRefOid && (passResult?.wait?.kind === "checks" && passResult.wait.headSha === pullRequest.headRefOid
            || passResult?.waitForChecksHead === pullRequest.headRefOid || hasPendingChecks(inboxClaim.snapshot, waitPolicy))) {
            // A reproduced external gate waits on this head until its evidence changes.
            outcome = "waiting";
            // Evidence that changed during the pass makes this wait stale, and the PR stays claimable.
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, progress: { kind: "no-progress" },
              wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), ...(assessed && merge.mode === "direct" ? { retryAt: Date.now() + 120_000 } : {}) } });
          } else if (assessed) {
            outcome = "waiting";
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), ...(assessed && merge.mode === "direct" ? { retryAt: Date.now() + 120_000 } : {}) } });
          } else {
            // A park that names no external gate still consumed a pass without progress.
            outcome = "retry";
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, retry: true, progress: { kind: "no-progress" } });
          }
          if (recorded && ciRecovery?.state === "blocked" && ciRecovery.permission) {
            await pullRequestInbox.setMeta(`ci-permission-fallback:v1:${inboxClaim.snapshot.repository}:${inboxClaim.snapshot.pr?.head?.sha ?? ""}`, { consumedAt: Date.now(), evidenceKey: fallbackEvidenceKey });
          }
        } catch (error) {
          if (modelWorkParked) return;
          if (error instanceof GitHubWorkspaceInstallError) {
            outcome = "waiting";
            const wait = createCheckWait(inboxClaim.snapshot, waitPolicy);
            wait.kind = "external";
            wait.reason = error.message;
            if (error.retryable) wait.retryAt = Date.now() + 300_000;
            await pullRequestInbox.finish(inboxClaim, { text: error.message, wait });
            schedulerError("babysitter.install.failed", error, owner);
            return;
          }
          if (pushedHead && (await pullRequestInbox.get(repository, number))?.status !== "terminal") {
            // The repair reached GitHub. Its checks and reviews resume the PR.
            outcome = "waiting";
            await parkOnPushedHead(inboxClaim, error instanceof Error ? error.message : String(error), pushedHead, [...verifiedPushHeads], passResult?.wait);
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
          // A rejected or ambiguous host merge retains its durable attempt
          // fence, but a finished owner must never retain a queue lease.
          // Normal finish/release paths have already cleared this token.
          try {
            await pullRequestInbox.release(inboxClaim);
          } finally {
            // State-store cleanup and event callbacks cannot retain process capacity.
            active.delete(`${repository}#${number}`);
            schedulerEvent("babysitter.owner.finished", {
              durationMs: Date.now() - startedAt,
              outcome,
              ...owner,
            });
            options.wake?.();
          }
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
