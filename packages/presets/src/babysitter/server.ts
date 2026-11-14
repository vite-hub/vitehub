import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { presetsBuildRevision } from "../internal/build-revision.ts";
import { GitHubDependencyConflictError } from "../github/index.ts";
import { presetsErrorDiagnostics } from "../error-diagnostics.ts";
import * as v from "valibot";
import { join, resolve } from "node:path";
import { forgeBranchRules, forgeErrorStatus, forgeMerge, MergeBlockedError, RateLimitedError, repoRef, retargetPullRequest, type ThreadRef } from "@vite-hub/forge";
import { prepareGitHubRepairBase } from "../github/index.ts";
import type { GitHubConflictResolution } from "../github/index.ts";
import { assertGitHubDependenciesCurrent, createGitHubInstallSlots, GitHubWorkspaceInstallError, hasCurrentGitHubDependencies, installGitHubPullRequestWorkspace, isGitHubLockfileDefect, readGitHubDependencyStatus } from "../github/index.ts";
import { resolvePublicUrl, resolveRuntimeValue } from "@vite-hub/runtime";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";
import { resolveRegisteredWorkspaceDefinition } from "@vite-hub/workspace";
import type { ProcessReconcilerRunContext } from "@vite-hub/runtime/internal/node";
import { activeProviderSandbox, agentSettings, createMessage, defineAgent, runAgent, publishAgentActivity, withoutForgeAccess } from "@vite-hub/agent";
import type { AgentCapabilitiesResolver, AgentInput, AgentProviderCredentialContext, AgentProviderLaunchContext, ClaudeCodeDriver, CodexDriver } from "@vite-hub/agent";
import {
  createGitHubPullRequestRun,
  createGitHubPullRequestOperations,
} from "../github/index.ts";
import type { GitHubHost } from "../github/index.ts";
import { PullRequestInbox, normalizePullRequest, type Claim, type Snapshot } from "./inbox/store.ts";
import { matchesBabysitterPullRequestFilter } from "./pull-request-filter.ts";
import { snapshotPrompt, assertPromptFits } from "./inbox/snapshot-prompt.ts";
import { snapshotPullRequest, createClaimStopCheck, claimStopReason } from "./inbox/claim-state.ts";
import { hydrateSnapshot, reconcileOneSnapshot, readForgePullRequestThreads, detectChangedPullRequests, probeChangedSnapshots, type ReadGraphql } from "./inbox/snapshot-sync.ts";
import type { PullRequestInboxStorage } from "./inbox/storage.ts";
import { actionLocation, hydrateFailedCiEvidence, newestCheckRun } from "./inbox/ci-evidence.ts";
import type { PullRequestWake } from "./inbox/wait-state.ts";
import { parseEvidence, type GitHubEvidence } from "./inbox/types.ts";
import { createHash } from "node:crypto";
import { resolveBabysitterLifecycleFilter } from "../babysitter.ts";
import type { BabysitterAgent, BabysitterPassResult, BabysitterPlacementLease } from "../babysitter.ts";
import { isBabysitterPlacementCapacityError } from "./placement.ts";
import { importSandboxCommit } from "./box-commit.ts";
import { createProviderHeadReader } from "./checkout-watch.ts";
import { importSandboxRepairFiles, importSandboxRepairWorkspace, publishSandboxDependencies } from "./box-repair.ts";
import { readBabysitterFeedback } from "./feedback.ts";
import { createBabysitterPassResultSchema } from "./result.ts";
import { repairCapability, repairEnvironment } from "./repair.ts";
import { createGitHubRequiredCheckPolicyReader, evaluateGitHubRequiredChecks, type GitHubRequiredCheckPolicy } from "../github/index.ts";
import { directMergeReadiness, feedbackFingerprints, hasHumanComment, liveMergeReadiness, matchesMergeReviewEvidence, resolveBabysitterMerge, snapshotCheckEvidence, mergeReviewEvidenceKey } from "./merge.ts";
import { checksDependencyEvidence, checksStillRunning, conflictOnlyBlockers, createCheckWait, dailyPassExemption, failedConclusions, failureKeys, hasPendingChecks, humanFeedbackExemption, latestCheckSignals, missingRequiredChecks, pushCause, severeReviewSettled, reviewCheckRunning, reviewPushBudgetSpent, reviewPushBudgetWork, wakeReasons, type BabysitterWaitPolicy } from "./wait.ts";
import { dailyPassResumeAt, nextReviewPushBudget, repairPushAllowance, type ProgressOutcome } from "./inbox/budgets.ts";
import { createForgeQuota, createProviderQuota } from "./provider-quota.ts";
import { baseFixedSinceFailure, checksTestedBase, staleBaseOverlap, type BaseFreshnessReader } from "./base-freshness.ts";
import { currentActionRuns, failedOwnActions, inheritedBypassSafety, inheritedCheckEvaluation, jobFailureFacts, parseFailedActionOutput, sameActionFailure, unrelatedFailureWait, type FailedActionOutput, type FailureCause, type InheritedCheckEvaluation, type JobFailureFacts } from "./ci-attribution.ts";
import { nonDefaultBase, stackRetargetBase, directMergeBranchSafety, sameRepositoryBranches, stackChildBaseDeletion } from "./stack.ts";
import { babysitterModelAdmission, type BabysitterAdmissionResult } from "./admission.ts";
import { boundedMergeReady } from "./merge-ready.ts";
import { createBabysitterInstaller } from "./install.ts";
import { hasFailedActions, rerunFailedActions } from "./ci-recovery.ts";
import { createBabysitterStatusRecovery, isWorkerBlocker } from "./status-recovery.ts";
import { providerSessionDecision, workspaceDecision, type PullRequestWorkspaceEntry, type PullRequestWorkspaces } from "./pr-workspaces.ts";
import type { BabysitterRepositories } from "./repositories.ts";
import { createBabysitterCheckRuns } from "./check-run.ts";
import { isTransientNetworkError, retryTransient } from "./transient.ts";
import { isFailedBaseRun, mainRepairWorkerContext, repairBaseBranch, type MainRepairGitHub } from "./main-repair.ts";

export type { PullRequestInboxStorage } from "./inbox/storage.ts";
export { createGitHubAppCredentials, createGitHubHost } from "../github/host.ts";
export type {
  GitHubAppEnvironment,
  GitHubHost,
  GitHubHostAccess,
  GitHubHostAccessOptions,
  GitHubHostCheckout,
  GitHubHostCheckoutOptions,
  GitHubHostCredentialContext,
  GitHubHostCredentials,
  GitHubHostForgeOptions,
  GitHubHostOptions,
  GitHubHostPullRequest,
  GitHubHostRateLimit,
  GitHubHostSecret,
} from "../github/host.ts";

declare const __VITEHUB_PRESETS_BUILD_REVISION__: string;

/** The first and the longest wait before a reviewed head's merge gates are checked again. */
const mergeRetryMinMs = 2 * 60_000;
const mergeRetryMaxMs = 30 * 60_000;

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
  /**
   * Repositories to discover and serve: a fixed list, or a source such as every repository of the
   * GitHub App installations, which each reconcile reads again.
   */
  repositories: readonly string[] | BabysitterRepositories;
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
  /** Delay between live reads while GitHub computes mergeability before a direct merge. Defaults to 3 seconds. */
  mergeabilityRetryDelayMs?: number;
  admission?: () => Promise<Pick<BabysitterAdmissionResult, "accepting" | "hostOnly" | "reason" | "retryAt" | "detail">>;
  /** One kept workspace per open PR. Without it, each pass clones and installs into temporary directories. */
  workspaces?: PullRequestWorkspaces;
}

/** Inbox meta key of the review threads a worker declined while their reviewer labeled them P0 or P1. */
const heldThreadsKey = (repository: string, number: number) => `held-review-threads:${repository}#${number}`;

/** How long an external blocker waits before another pass. */
const externalRetryMs = 2 * 60 * 60_000;
/** How long a head may wait for GitHub to compute its mergeability before its pass runs anyway. */
const unknownMergeabilityLimitMs = 10 * 60_000;
/** How long a pending GitHub merge request is polled before the Babysitter stops waiting for it. */
const pendingMergeDeadlineMs = 30 * 60_000;
/** How long a stopped merge request keeps its head from a new request. */
const stoppedMergeRetryMs = 2 * 60 * 60_000;

/**
 * GitHub settles most asynchronous merges in seconds, so poll a pending request less often as it ages:
 * after 30 seconds at first, then after as long as it has been pending, at most every five minutes.
 * vite-hub/vitehub#3350 was polled every 30 seconds for 19 hours.
 */
export function pendingMergeRetryAt(startedAt: number, now: number): number {
  return now + Math.min(5 * 60_000, Math.max(30_000, now - startedAt));
}

/** The `status` of GitHub's merge result that a merge rejection carries in its response excerpt. */
function mergeResultStatus(error: MergeBlockedError): string | undefined {
  try {
    const body: unknown = JSON.parse(error.body);
    return isRuntimeRecord(body) && hasRuntimeType(body.status, "string") ? body.status : undefined;
  } catch {
    return undefined;
  }
}

/** Provider quota and rate-limit failures. Cancellation is never a rate limit. */
export function isProviderRateLimit(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof RateLimitedError) return true;
  return [error, error instanceof Error ? error.cause : undefined].some((candidate) =>
    isRuntimeRecord(candidate) && candidate.code === "AGENT_R0726"
      && hasRuntimeType(candidate.message, "string")
      && /\b429\b|too many requests|rate limit|\busage limit\b/i.test(candidate.message));
}

/** A provider failure that says nothing about the PR: a rate limit or a stream the provider dropped. */
function isProviderFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  return isProviderRateLimit(error) || [error, error instanceof Error ? error.cause : undefined].some(candidate =>
    isRuntimeRecord(candidate) && hasRuntimeType(candidate.message, "string")
      && /stream disconnected before completion|stream closed before response\.completed/i.test(candidate.message));
}

/** A provider failure this soon after dispatch gives the daily pass back. A longer pass did real work. */
const providerFailureReleaseMs = 10 * 60_000;

/** Own one durable PR inbox and its repair passes inside a process host. */
export interface BabysitterRuntime {
  inbox: PullRequestInbox;
  /** The repositories this runtime discovers and serves. */
  repositories: BabysitterRepositories;
  reconcile(
    reason: string,
    context: ProcessReconcilerRunContext,
    accepting?: () => boolean,
  ): Promise<void>;
  workload(): { running: number };
  /**
   * Makes the next reconcile check the default branch of the delivery's repository when the delivery
   * is a failed push run of a watched workflow there. Returns whether it did.
   */
  observeMainRepair(event: string, payload: unknown): Promise<boolean>;
}

export function createBabysitterRuntime(options: BabysitterRuntimeOptions): BabysitterRuntime {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Babysitter concurrency must be a positive integer.");
  }
  const baseAgent = options.agent;
  assertBabysitterAgent(baseAgent);
  const presetOptions = baseAgent.options;
  const filter = resolveBabysitterLifecycleFilter(presetOptions.filter, presetOptions.lifecycle);
  const merge = resolveBabysitterMerge(presetOptions.merge);
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
  const reviewPushBudget = baseAgent.reviewPushBudget ?? presetOptions.reviewPushBudget ?? 3;
  const dailyPassBudget = baseAgent.dailyPassBudget ?? presetOptions.dailyPassBudget ?? 16;
  const dailyPushBudget = presetOptions.dailyPushBudget ?? false;
  const repositorySource = fixedOrSource(options.repositories);
  const minorReviewRounds = presetOptions.minorReviewRounds ?? false;
  const reviewConvergencePushes = presetOptions.reviewConvergencePushes ?? false;
  const repairStackChildren = merge.mode === "direct" && presetOptions.repairStackChildren === true;
  const pullRequestInbox = new PullRequestInbox({
    ...(options.inboxStorage ? { storage: options.inboxStorage, scope: options.inboxScope ?? options.agentName ?? baseAgent.name ?? "babysitter" } : { path: options.inboxPath }),
    repositories: () => repositorySource.known(),
    filter,
    activityAuthors,
    activityAppId: verifiedHostIdentity ? github.appId?.() : undefined,
    budgets: { ...noProgressBudget === false ? {} : { noProgress: noProgressBudget }, ...reviewPushBudget === false ? {} : { reviewPushes: reviewPushBudget },
      ...reviewPushBudget === false || minorReviewRounds === false ? {} : { minorReviewRounds },
      ...dailyPassBudget === false ? {} : { dailyPasses: dailyPassBudget } },
    priorityLabels: presetOptions.priorityLabels ?? [],
    mainRepairBranchPrefix: presetOptions.mainRepairBranchPrefix,
    claimStackChildren: repairStackChildren,
    // One invalid row must not stop the claim loop or the health endpoint.
    invalidRow: ({ repository, number, error }) => options.error?.("babysitter.inbox.invalid_row", error, { repository, pullRequest: number }),
  });
  const ciRecoveryEnabled = presetOptions.ciRecovery ?? true;
  const modelConcurrency = presetOptions.modelConcurrency ?? Number.POSITIVE_INFINITY;
  const providerQuota = createProviderQuota(pullRequestInbox, presetOptions.providerCooldownMs ?? 5 * 60_000);
  const forgeQuota = createForgeQuota(pullRequestInbox);
  // Owner capacity includes host-only work, while this separate gate limits
  // the number of providers that may be running at once.
  let activeModelPasses = 0;
  const modelSlotWaiters = new Set<() => void>();
  const waitingModelOwners = new Set<string>();
  const acquireModelSlot = async (abortSignal: AbortSignal, ownerKey: string) => {
    waitingModelOwners.add(ownerKey);
    try {
      while (activeModelPasses >= await providerQuota.modelLimit(options.concurrency, modelConcurrency)) {
        await new Promise<void>((resolve, reject) => {
          const wake = () => { abortSignal.removeEventListener("abort", abort); resolve(); };
          const abort = () => { modelSlotWaiters.delete(wake); reject(new DOMException("The operation was aborted.", "AbortError")); };
          modelSlotWaiters.add(wake);
          if (abortSignal.aborted) abort();
          else abortSignal.addEventListener("abort", abort, { once: true });
        });
      }
      activeModelPasses++;
    } finally {
      waitingModelOwners.delete(ownerKey);
    }
  };
  const releaseModelSlot = () => {
    activeModelPasses = Math.max(0, activeModelPasses - 1);
    for (const wake of modelSlotWaiters) wake();
    modelSlotWaiters.clear();
  };
  const deferWhilePending = baseAgent.deferWhilePending ?? presetOptions.deferWhilePending ?? true;
  const waitPolicy: BabysitterWaitPolicy = {
    ignoreFeedbackAuthors: new Set((baseAgent.ignoreFeedbackAuthors ?? presetOptions.ignoreFeedbackAuthors ?? []).map(author => author.trim().toLowerCase())),
    workerAuthors: new Set(activityAuthors.flatMap(author => [author.toLowerCase(), `${author.toLowerCase().replace(/\[bot\]$/, "")}[bot]`])),
    pendingReviewChecks: new Set((presetOptions.reviewChecks ?? []).map(name => name.toLowerCase())),
    wakeWhenReady: merge.mode === "direct",
    noFindingsReviews: baseAgent.noFindingsReviews ?? presetOptions.noFindingsReviews ?? [],
    ...reviewPushBudget === false ? {} : { reviewPushBudget },
    ignoreAssessedBotThreads: presetOptions.ignoreAssessedBotThreads === true,
  };
  const schedulerEvent = (name: string, properties: Record<string, unknown> = {}) =>
    options.event?.(name, properties);
  // Built packages carry this fingerprint; direct source hosts compute the same inputs.
  const release = baseAgent.version ?? (typeof __VITEHUB_PRESETS_BUILD_REVISION__ === "undefined" ? presetsBuildRevision(fileURLToPath(new URL("../../", import.meta.url))) : __VITEHUB_PRESETS_BUILD_REVISION__);
  const workspaces = options.workspaces;
  const schedulerError = (name: string, error: unknown, properties: Record<string, unknown> = {}) =>
    options.error?.(name, error, properties);
  const statusComment = !!verifiedHostIdentity && presetOptions.status?.comment !== false;
  const statusCheckRun = !!verifiedHostIdentity && presetOptions.status?.checkRun !== false;
  const statusChannel = statusComment ? github.channel({ activity: true, pullRequest: { workspace: false } }) : undefined;
  const checkRuns = statusCheckRun
    ? createBabysitterCheckRuns({ forge: async (repository, signal) => await github.forge({ repository, signal }), appId: github.appId?.(), error: schedulerError })
    : undefined;
  const statusRecovery = createBabysitterStatusRecovery({
    inbox: pullRequestInbox,
    // Built packages carry this fingerprint; direct source hosts compute the same inputs.
    revision: release,
    // One delivery writes both views, so a failure of either retries through the outbox.
    publish: statusChannel || checkRuns ? async (pending, abortSignal) => {
      if (statusChannel) {
        await publishAgentActivity({ name: `${options.agentName ?? baseAgent.name ?? "babysitter"}-worker`, channels: { github: statusChannel } }, {
          channelId: "github", target: { repository: pending.repository, issue: pending.number }, activity: pending.activity, abortSignal,
        });
      }
      await checkRuns?.publish(pending, abortSignal);
    } : undefined,
    event: schedulerEvent,
    error: schedulerError,
  });
  const active = new Set<string>();

  /** A Forge provider with the repository's credentials, and refs into the repository. */
  async function forge(repository: string, signal?: AbortSignal) {
    const provider = await retryTransient(() => github.forge({ repository, signal }), signal);
    const repo = repoRef(provider, repository);
    const pull = (number: number): ThreadRef => ({ forge: provider.forge, instance: provider.instance, repo, kind: "pull_request", number: String(number) });
    return { provider, repo, pull };
  }

  /**
   * The pull request as GitHub's REST API reports it, with `mergeable_state` and the base repository.
   * forges `threads.get()` also reads every check of the head, which costs two more requests.
   */
  async function readPull(repository: string, number: number, signal?: AbortSignal): Promise<unknown> {
    const { provider } = await forge(repository, signal);
    return (await retryTransient(() => provider.request<unknown>("GET", `/repos/${repository}/pulls/${number}`, { signal }), signal)).data;
  }

  /** Pull requests by head or base branch. forges `threads.list()` cannot filter by branch. */
  async function readPulls(repository: string, query: { state: "open" | "all"; base?: string; head?: string; limit: number }, signal?: AbortSignal): Promise<unknown[]> {
    const { provider } = await forge(repository, signal);
    const pulls: unknown[] = [];
    for (let page = 1; pulls.length < query.limit; page++) {
      const perPage = Math.min(100, query.limit);
      const response = await retryTransient(() => provider.request<unknown>("GET", `/repos/${repository}/pulls`, { query: { state: query.state, base: query.base, head: query.head, per_page: perPage, page }, signal }), signal);
      if (!Array.isArray(response.data)) throw new Error("GitHub did not return a pull request list.");
      pulls.push(...response.data);
      if (response.data.length < perPage) break;
    }
    return pulls.slice(0, query.limit);
  }

  /**
   * REST reads for the inbox snapshot readers, in the shape their parsers expect.
   * Endpoint gaps use the provider request escape hatch with Forge credentials.
   */
  async function readRest(path: string, projection = ".[]", signal?: AbortSignal): Promise<unknown[]> {
    const repository = path.split("/").slice(1, 3).join("/");
    const { provider } = await forge(repository, signal);
    const items: unknown[] = [];
    let next: string | undefined = `/${path}`;
    while (next) {
      const path = next;
      const response: { data: unknown; headers: Headers } = await retryTransient(() => provider.request<unknown>("GET", path, { signal }), signal);
      if (projection === ".") items.push(response.data);
      else {
        const key = /^\.(\w+)\[\]$/.exec(projection)?.[1];
        const list = key ? (isRuntimeRecord(response.data) ? response.data[key] : undefined) : response.data;
        if (!Array.isArray(list)) throw new Error(`GitHub did not return a list for ${path}.`);
        items.push(...list);
      }
      next = response.headers.get("link")?.split(",").map(part => /<([^>]+)>\s*;\s*rel="next"/.exec(part)?.[1]).find(Boolean);
    }
    return items;
  }

  /** The first page of a REST read as GitHub returns it, for responses whose later pages add nothing the caller uses. */
  async function readOnePage(path: string, signal?: AbortSignal): Promise<unknown> {
    const repository = path.split("/").slice(1, 3).join("/");
    const { provider } = await forge(repository, signal);
    return (await retryTransient(() => provider.request<unknown>("GET", `/${path}`, { signal }), signal)).data;
  }
  const freshnessReader: BaseFreshnessReader = {
    rest: (path, signal, key) => readRest(path, key ? `.${key}[]` : ".[]", signal),
    page: readOnePage,
  };

  // Main repair: one check per repository every 10 minutes, or at once after a failed push run on the default branch.
  const mainRepairPrefix = presetOptions.mainRepairBranchPrefix;
  const mainRepair = presetOptions.mainRepair && mainRepairPrefix ? presetOptions.mainRepair : undefined;
  const mainRepairRepositories = mainRepair?.repositories?.map(repository => repository.toLowerCase());
  const mainRepairIntervalMs = 10 * 60_000;
  const mainRepairRunning = new Set<string>();
  const mainRepairKey = (repository: string) => `main-repair-next:${repository.toLowerCase()}`;
  const mainRepairWatches = (repository: string) => repositorySource.known().includes(repository.toLowerCase())
    && (!mainRepairRepositories || mainRepairRepositories.includes(repository.toLowerCase()));
  function mainRepairGitHub(repository: string, signal: AbortSignal): MainRepairGitHub {
    return {
      async read(path, query) {
        const { provider } = await forge(repository, signal);
        try {
          return (await retryTransient(() => provider.request<unknown>("GET", `/${path}`, { query, signal }), signal)).data;
        } catch (error) {
          if (forgeErrorStatus(error) === 404) return undefined;
          throw error;
        }
      },
      async write(path, body) {
        const { provider } = await forge(repository, signal);
        return (await provider.request<unknown>("POST", `/${path}`, { body, signal })).data;
      },
    };
  }
  async function checkMainRepairs(repositories: readonly string[], track: ProcessReconcilerRunContext["track"]) {
    if (!mainRepair || !mainRepairPrefix) return;
    for (const repository of repositories) {
      if (!mainRepairWatches(repository) || mainRepairRunning.has(repository)) continue;
      if ((await pullRequestInbox.metaNumber(mainRepairKey(repository)) ?? 0) > Date.now()) continue;
      await pullRequestInbox.setMeta(mainRepairKey(repository), Date.now() + mainRepairIntervalMs);
      mainRepairRunning.add(repository);
      void track(repairBaseBranch(mainRepairGitHub(repository, AbortSignal.timeout(5 * 60_000)), { repository, branchPrefix: mainRepairPrefix, mainRepair, event: schedulerEvent })
        .catch(async (error: unknown) => {
          await noteForgeQuota(error, "main-repair");
          schedulerError("babysitter.main_repair.failed", error, { repository });
        })
        .finally(() => mainRepairRunning.delete(repository)));
    }
  }
  async function observeMainRepair(event: string, payload: unknown): Promise<boolean> {
    if (!mainRepair || !isFailedBaseRun(event, payload, mainRepair.workflows)) return false;
    const repository = isRuntimeRecord(payload) && isRuntimeRecord(payload.repository) ? payload.repository.full_name : undefined;
    if (!hasRuntimeType(repository, "string") || !mainRepairWatches(repository)) return false;
    await pullRequestInbox.setMeta(mainRepairKey(repository), 0);
    return true;
  }

  /**
   * Marks a reviewed draft ready for review when `merge.markDraftsReady` lists its author and its head
   * branch is in the repository. GitHub's live PR must still be that draft at the reviewed head.
   */
  async function markDraftReady(snapshot: Snapshot, owner: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    const authors = merge.mode === "direct" ? merge.markDraftsReady : undefined;
    if (!authors) return false;
    const { repository, number } = snapshot;
    const allowed = (pr: unknown): pr is Record<string, unknown> => {
      if (!isRuntimeRecord(pr) || pr.draft !== true || !isRuntimeRecord(pr.user) || !isRuntimeRecord(pr.head) || !isRuntimeRecord(pr.head.repo)) return false;
      return pr.head.sha === snapshot.pr?.head?.sha && hasRuntimeType(pr.user.login, "string") && authors.has(pr.user.login.toLowerCase())
        && String(pr.head.repo.full_name).toLowerCase() === repository.toLowerCase();
    };
    if (!allowed(snapshot.pr)) return false;
    let failure: string | undefined;
    try {
      const live = await readPull(repository, number, signal);
      if (!allowed(live) || !hasRuntimeType(live.node_id, "string")) return false;
      // forges has no ready-for-review operation, and GitHub's REST API cannot clear the draft flag.
      const { provider } = await forge(repository, signal);
      const query = "mutation BabysitterMarkDraftReady($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}";
      const response = (await provider.request<unknown>("POST", "/graphql", { body: { query, operationName: "BabysitterMarkDraftReady", variables: { id: live.node_id } }, signal })).data;
      if (isRuntimeRecord(response) && Array.isArray(response.errors) && response.errors.length > 0) {
        failure = response.errors.map(error => isRuntimeRecord(error) && hasRuntimeType(error.message, "string") ? error.message : String(error)).join("; ");
      }
    } catch (error) {
      await noteForgeQuota(error, "draft-ready");
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      schedulerEvent("babysitter.draft.ready_failed", { ...owner, reason: failure.slice(0, 200) });
      return false;
    }
    schedulerEvent("babysitter.draft.ready", { ...owner, head_sha: snapshot.pr?.head?.sha });
    return true;
  }

  /**
   * Merges the base into the PR branch through GitHub, without a model pass. False when GitHub refuses.
   * `pr` is the live or snapshot PR; its branches allow the merges API fallback.
   */
  async function updateBranch(owner: Record<string, unknown>, repository: string, number: number, head: string, signal: AbortSignal, pr: unknown): Promise<boolean> {
    try {
      // forges has no branch update, so this uses the provider request escape hatch.
      const { provider } = await forge(repository, signal);
      await provider.request("PUT", `/repos/${repository}/pulls/${number}/update-branch`, { body: { expected_head_sha: head }, signal });
      return true;
    } catch (error) {
      await noteForgeQuota(error, "update-branch");
      const branches = sameRepositoryBranches(pr, repository);
      // GitHub refuses update-branch for a PR it treats as part of a stack, and for some App
      // installations. Merging the base into a same-repository head branch does the same update.
      if (!branches || error instanceof RateLimitedError || forgeErrorStatus(error) !== 403 && !/stacked/i.test(error instanceof Error ? error.message : String(error))) {
        schedulerEvent("babysitter.branch.update_failed", { ...owner, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
        return false;
      }
      try {
        const { provider } = await forge(repository, signal);
        const ref = (await provider.request<unknown>("GET", `/repos/${repository}/git/ref/heads/${encodeURIComponent(branches.head)}`, { signal })).data;
        if (!isRuntimeRecord(ref) || !isRuntimeRecord(ref.object) || ref.object.sha !== head) {
          schedulerEvent("babysitter.branch.update_failed", { ...owner, reason: "merges API fallback: head changed" });
          return false;
        }
        await provider.request("POST", `/repos/${repository}/merges`, {
          body: { base: branches.head, head: branches.base, commit_message: `Merge ${branches.base} into ${branches.head}` }, signal,
        });
        return true;
      } catch (fallback) {
        await noteForgeQuota(fallback, "merge-base-into-head");
        schedulerEvent("babysitter.branch.update_failed", { ...owner, reason: `merges API fallback: ${(fallback instanceof Error ? fallback.message : String(fallback)).slice(0, 180)}` });
        return false;
      }
    }
  }

  /**
   * Failed checks that ran on an older base get one retest on the current base before a model pass,
   * when the base tip has no failing check. One retest per PR every six hours.
   */
  async function retestOnCurrentBase(snapshot: Snapshot, owner: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    const { repository, number } = snapshot;
    const pr = snapshot.pr;
    const head = pr?.head?.sha;
    if (!head || !pr?.base?.ref || pr.draft || pr.mergeable === false || pr.mergeable_state === "dirty") return false;
    if (!failureKeys(snapshot).length || checksStillRunning(snapshot)) return false;
    const key = `base-retest:${repository}#${number}`;
    if ((await pullRequestInbox.metaNumber(key) ?? 0) > Date.now() - 6 * 60 * 60_000) return false;
    const ahead = await baseFixedSinceFailure(freshnessReader, snapshot, failedConclusions, signal);
    if (!ahead) return false;
    if (!await updateBranch(owner, repository, number, head, signal, pr)) return false;
    await pullRequestInbox.setMeta(key, Date.now());
    schedulerEvent("babysitter.branch.retest", { ...owner, base_ahead: ahead });
    return true;
  }

  const conflicted = (snapshot: Snapshot) => snapshot.pr?.mergeable === false || snapshot.pr?.mergeable_state === "dirty";

  /**
   * A job that a runner or network error stopped gets a fresh CI run: the host updates the branch, once
   * per head and base and at most hourly per PR. On 2026-11-09 vitehub#3534 waited 14 hours on a 504
   * from setup-deno that nothing retried.
   */
  async function retestInfrastructureFailure(snapshot: Snapshot, owner: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    const { repository, number } = snapshot;
    const pr = snapshot.pr;
    const head = pr?.head?.sha;
    if (!head || !pr?.base?.ref || pr.draft || conflicted(snapshot)) return false;
    const key = `infrastructure-retest:${repository}#${number}`;
    const previous = await pullRequestInbox.meta(key);
    if (isRuntimeRecord(previous) && (previous.head === head && previous.base === pr.base.sha || Number(previous.at) > Date.now() - 60 * 60_000)) return false;
    await pullRequestInbox.setMeta(key, { head, base: pr.base.sha, at: Date.now() });
    if (!await updateBranch(owner, repository, number, head, signal, pr)) return false;
    schedulerEvent("babysitter.branch.retest", { ...owner, cause: "infrastructure" });
    return true;
  }

  /**
   * A required check that never reported gets a fresh run: a branch behind its base is updated, and a
   * current one has its head's Actions runs rerun. Once per head every six hours.
   */
  async function retestMissingRequiredChecks(snapshot: Snapshot, owner: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    const { repository, number } = snapshot;
    const pr = snapshot.pr;
    const head = pr?.head?.sha;
    const baseRef = pr?.base?.ref;
    if (!head || !baseRef || pr.draft || conflicted(snapshot)) return false;
    const missing = missingRequiredChecks(snapshot, await requiredCheckEvaluation(snapshot, signal));
    if (!missing.length) return false;
    const key = `missing-check-retest:${repository}#${number}`;
    const previous = await pullRequestInbox.meta(key);
    if (isRuntimeRecord(previous) && previous.head === head && Number(previous.at) > Date.now() - 6 * 60 * 60_000) return false;
    await pullRequestInbox.setMeta(key, { head, at: Date.now() });
    const compare = await readOnePage(`repos/${repository}/compare/${head}...${encodeURIComponent(baseRef)}?per_page=1`, signal).catch(() => undefined);
    if (isRuntimeRecord(compare) && Number(compare.ahead_by) > 0 && await updateBranch(owner, repository, number, head, signal, pr)) {
      schedulerEvent("babysitter.required_check.retest", { ...owner, missing, via: "update-branch", base_ahead: compare.ahead_by });
      return true;
    }
    const runs = [...new Set(latestCheckSignals(snapshot).flatMap(check => actionLocation(repository, check)?.runId ?? []))];
    if (!runs.length) return false;
    try {
      const { provider } = await forge(repository, signal);
      // forges CI is read-only, so it cannot rerun a workflow run.
      for (const runId of runs) await provider.request("POST", `/repos/${repository}/actions/runs/${runId}/rerun`, { signal });
    } catch (error) {
      await noteForgeQuota(error, "rerun");
      schedulerEvent("babysitter.required_check.retest_failed", { ...owner, missing, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      return false;
    }
    schedulerEvent("babysitter.required_check.retest", { ...owner, missing, via: "rerun", runs });
    return true;
  }

  /** What one failed Actions job's log shows, cached by job and completion. Undefined when the log is unavailable. */
  const jobFailures = new Map<string, { facts: JobFailureFacts; output: FailedActionOutput | undefined }>();
  async function jobFailure(repository: string, check: GitHubEvidence, signal: AbortSignal) {
    const jobId = actionLocation(repository, check)?.jobId;
    if (!jobId) return undefined;
    const key = JSON.stringify([repository.toLowerCase(), jobId, check.completed_at ?? check.updated_at]);
    const cached = jobFailures.get(key);
    if (cached) return cached;
    let log: string;
    try {
      const { provider } = await forge(repository, signal);
      log = await new Response((await provider.request("GET", `/repos/${repository}/actions/jobs/${jobId}/logs`, { raw: true, signal })).body).text();
    } catch (error) {
      await noteForgeQuota(error, "job-log");
      return undefined;
    }
    const value = { facts: jobFailureFacts(log), output: parseFailedActionOutput(log) };
    if (jobFailures.size >= 128) jobFailures.delete(jobFailures.keys().next().value!);
    jobFailures.set(key, value);
    return value;
  }

  /** The newest GitHub Actions run of each check on a base commit. */
  async function baseActionRuns(repository: string, ref: string, signal: AbortSignal): Promise<Map<string, GitHubEvidence>> {
    const newest = new Map<string, GitHubEvidence>();
    for (const value of await readRest(`repos/${repository}/commits/${ref}/check-runs?per_page=100`, ".check_runs[]", signal)) {
      const check = parseEvidence(value);
      if (check.app?.slug !== "github-actions") continue;
      newest.set(String(check.name), newestCheckRun(newest.get(String(check.name)), check));
    }
    return newest;
  }

  /**
   * Current-head Actions checks that only repeat the base's failure: the same job fails in the same step
   * on the base tip, and the PR's output names no failure the base's lacks. A missing log proves nothing.
   * `baseSha` pins the base commit; without it, a tip whose checks still run falls back to the base that
   * these checks tested, unless the tip already finished that check.
   */
  async function readInheritedBaseFailures(snapshot: Snapshot, signal: AbortSignal, baseSha?: string): Promise<number[]> {
    const { repository } = snapshot;
    const head = snapshot.pr?.head?.sha;
    const baseRef = snapshot.pr?.base?.ref;
    if (!head || !baseRef || conflicted(snapshot) || checksStillRunning(snapshot)) return [];
    const failing = currentActionRuns(snapshot, waitPolicy.pendingReviewChecks).filter(check => failedConclusions.has(String(check.conclusion)));
    if (!failing.length) return [];
    const tip = await baseActionRuns(repository, baseSha ?? encodeURIComponent(baseRef), signal);
    const inherited = new Map([...tip].filter(([, check]) => failedConclusions.has(String(check.conclusion))));
    if (!baseSha && failing.some(check => tip.get(String(check.name))?.status !== "completed")) {
      const tested = await checksTestedBase(freshnessReader, snapshot, head, baseRef, failedConclusions, signal);
      if (tested) {
        for (const [name, check] of await baseActionRuns(repository, tested, signal)) {
          if (tip.get(name)?.status !== "completed" && failedConclusions.has(String(check.conclusion))) inherited.set(name, check);
        }
      }
    }
    const ids: number[] = [];
    for (const check of failing) {
      const base = inherited.get(String(check.name));
      if (!base) continue;
      const [own, tested] = await Promise.all([jobFailure(repository, check, signal), jobFailure(repository, base, signal)]);
      if (sameActionFailure(own?.output, tested?.output)) ids.push(Number(check.id));
    }
    return ids;
  }

  const inheritedFailures = new Map<string, { ids: number[]; expiresAt: number }>();
  /** `readInheritedBaseFailures()` for the base branch, cached for five minutes per head, base and failures. */
  async function inheritedBaseFailures(snapshot: Snapshot, signal: AbortSignal): Promise<number[]> {
    const key = JSON.stringify([snapshot.repository, snapshot.pr?.base?.ref, snapshot.pr?.base?.sha, snapshot.pr?.head?.sha, failureKeys(snapshot)]);
    const cached = inheritedFailures.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.ids;
    let ids: number[];
    try {
      ids = await readInheritedBaseFailures(snapshot, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      await noteForgeQuota(error, "inherited-failures");
      return [];
    }
    if (inheritedFailures.size >= 128) inheritedFailures.delete(inheritedFailures.keys().next().value!);
    inheritedFailures.set(key, { ids, expiresAt: Date.now() + 5 * 60_000 });
    return ids;
  }

  /** Why each failing current-head check outside the review checks fails. A cause the host cannot prove is `pr`. */
  async function failureCauses(snapshot: Snapshot, signal: AbortSignal): Promise<FailureCause[]> {
    const failing = latestCheckSignals(snapshot).filter(check => failedConclusions.has(String(check.conclusion ?? check.state))
      && !waitPolicy.pendingReviewChecks.has(String(check.name ?? check.context).toLowerCase()));
    if (!failing.length) return [];
    const inherited = new Set(await inheritedBaseFailures(snapshot, signal));
    const causes: FailureCause[] = [];
    for (const check of failing) {
      const name = String(check.name ?? check.context);
      const runId = actionLocation(snapshot.repository, check)?.runId;
      const run = runId === undefined ? {} : { runId };
      if (inherited.has(Number(check.id))) {
        causes.push({ name, ...run, cause: "inherited" });
        continue;
      }
      const job = runId === undefined ? undefined : await jobFailure(snapshot.repository, check, signal);
      if (job?.facts.infrastructure) causes.push({ name, ...run, cause: "infrastructure", line: job.facts.infrastructure });
      else if (job?.facts.gate) causes.push({ name, ...run, cause: "pr", gate: true });
      // A failure the PR may cause needs a repair pass, so the other logs are not needed.
      else return [...causes, { name, ...run, cause: "pr" }];
    }
    return causes;
  }

  const bypassChecksFor = (repository: string): ReadonlySet<string> =>
    (merge.mode === "direct" ? merge.bypassInheritedChecks?.get(repository.toLowerCase()) : undefined) ?? new Set();

  /** GraphQL reads for the inbox snapshot readers, with the `{ data }` envelope they parse. */
  function readGraphql(repository: string, signal?: AbortSignal): ReadGraphql {
    return async (query, variables) => {
      const { provider } = await forge(repository, signal);
      const operationName = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.[1];
      // Keep the GraphQL envelope intact. Snapshot readers validate `errors`
      // before consuming `data`, and partial responses must not become state.
      return await provider.request<unknown>("POST", "/graphql", { body: { query, variables, ...(operationName ? { operationName } : {}) }, signal }).then(response => response.data);
    };
  }

  async function readThreads(repository: string, number: number, signal?: AbortSignal) {
    const { provider } = await forge(repository, signal);
    return readForgePullRequestThreads(provider, repository, number, signal);
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

  const requiredChecks = createGitHubRequiredCheckPolicyReader(async (repository, branch) => {
    const { provider, repo } = await forge(repository);
    return await forgeBranchRules(provider, repo, branch);
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
    // A merge request whose outcome is unknown keeps its fence. Poll it less often as it ages.
    const parkMerge = async (reason: string, retryAt?: number) => {
      const attempt = retryAt === undefined ? await pullRequestInbox.directMergeAttempt(repository, number) : undefined;
      const now = Date.now();
      retryAt ??= attempt ? pendingMergeRetryAt(attempt.startedAt, now) : now + 30_000;
      await pullRequestInbox.finish(claim, { text: reason, wait: { ...createCheckWait(snapshot, waitPolicy), kind: "external", reason, retryAt } });
      return "blocked" as const;
    };
    const stoppedKey = `direct-merge-stopped:${repository}#${number}`;
    if (pending) {
      try {
        const live = await readPull(repository, number, signal);
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
          // forges has no merge queue model.
          const { provider } = await forge(repository, signal);
          const query = `query BabysitterMergeQueueEntry($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state headRefOid mergeQueueEntry{id}}}}`;
          const response = (await provider.request<unknown>("POST", "/graphql", { body: { query, operationName: "BabysitterMergeQueueEntry", variables: { owner: repositoryOwner, name, number } }, signal })).data;
          if (isRuntimeRecord(response) && Array.isArray(response.errors) && response.errors.length > 0) {
            const messages = response.errors.map(error => isRuntimeRecord(error) && hasRuntimeType(error.message, "string") ? error.message : String(error));
            throw new Error(`GitHub merge queue query failed: ${messages.join("; ")}`);
          }
          const queued = v.parse(v.object({ repository: v.object({ pullRequest: v.object({
            state: v.string(), headRefOid: v.string(), mergeQueueEntry: v.nullable(v.object({ id: v.string() })),
          }) }) }), isRuntimeRecord(response) && "data" in response ? response.data : response).repository.pullRequest;
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
        // A synchronous attempt can be reconciled from live PR state.
        // An asynchronous request may still be running. Re-admit it through every
        // gate below: GitHub serializes the duplicate request and forges waits for
        // the pending one. Never clear it just for being open.
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
        const age = Date.now() - pending.startedAt;
        if (pending.asynchronous && age >= pendingMergeDeadlineMs) {
          // Release the fence so a new head can merge, and keep this head from starting the same stuck request
          // again until the retry. A merge by hand or a new head ends the wait sooner.
          const until = Date.now() + stoppedMergeRetryMs;
          const reason = `Stopped waiting for the GitHub merge of ${pending.head}: it was still pending after ${Math.floor(age / 60_000)} minutes. The Babysitter requests it again at ${new Date(until).toISOString()}.`;
          await pullRequestInbox.setMeta(stoppedKey, { head: pending.head, until, reason });
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          schedulerEvent("babysitter.direct_merge.stopped", { ...owner, head_sha: pending.head, pending_minutes: Math.floor(age / 60_000) });
          return await parkMerge(reason, until);
        }
      } catch (error) {
        await noteForgeQuota(error, "merge-reconcile");
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: `merge outcome unknown: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}` });
        return await parkMerge("GitHub merge outcome could not be reconciled; retrying the provider read.");
      }
    }
    if (signal.aborted) return "blocked";
    const evaluation = await checkEvaluation(snapshot, await requiredChecks.read(repository, base), signal);
    const savedAssessment = await pullRequestInbox.meta(`review-assessment:${repository}#${number}`);
    // Version 1 also acknowledged feedback after a push without an explicit review.
    const assessment = isRuntimeRecord(savedAssessment) && savedAssessment.version === 2 ? savedAssessment : undefined;
    const reviewedEvidenceKey = isRuntimeRecord(assessment) && assessment.head === snapshot.pr?.head?.sha && hasRuntimeType(assessment.evidenceKey, "string") ? assessment.evidenceKey : undefined;
    const assessedFeedback = new Set(isRuntimeRecord(assessment) && Array.isArray(assessment.feedback) ? assessment.feedback.filter(item => hasRuntimeType(item, "string")) : []);
    const heldThreads = await heldOpenThreads(snapshot);
    const readiness = (checked: Snapshot, state: typeof evaluation.state, inheritedCheckIds: readonly number[]) => directMergeReadiness(checked, state, {
      ...waitPolicy, assessedFeedback, reviewedEvidenceKey, automatedReviewSettled: reviewPushBudgetSpent(snapshot, waitPolicy),
      severeReviewSettled: severeReviewSettled(snapshot, waitPolicy), heldThreads, inheritedCheckIds: new Set(inheritedCheckIds) });
    // Green PRs merge here without reaching the reviewed-head path that also marks drafts ready.
    if (!pending && snapshot.pr?.draft === true && evaluation.state !== "failed" && snapshot.pr.mergeable !== false
      && snapshot.pr.mergeable_state !== "dirty" && await markDraftReady(snapshot, owner, signal)) {
      await pullRequestInbox.finish(claim, { text: "Marked the draft ready for review so it can merge.", wait: { ...createCheckWait(snapshot, waitPolicy), retryAt: Date.now() + 120_000 } });
      return "blocked";
    }
    let decision = readiness(snapshot, evaluation.state, evaluation.inheritedCheckIds);
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
    const stopped = pending ? undefined : await pullRequestInbox.meta(stoppedKey);
    if (isRuntimeRecord(stopped) && stopped.head === decision.head && hasRuntimeType(stopped.until, "number") && stopped.until > Date.now()) {
      return await parkMerge(hasRuntimeType(stopped.reason, "string") ? stopped.reason : "Stopped waiting for a pending GitHub merge.", stopped.until);
    }
    let mergeStarted = false;
    const bypass = evaluation.bypassedRequiredChecks.length > 0;
    let inheritedProof: Exclude<Awaited<ReturnType<typeof verifyInheritedMerge>>, { refused: string }> | undefined;
    const mergeToken = pending?.token ?? claim.token;
    try {
      const { provider, repo, pull } = await forge(repository, signal);
      let live = await readPull(repository, number, signal);
      // GitHub computes mergeability after the first read, so give it a few seconds before parking the claim.
      for (let attempt = 0; attempt < 3 && isRuntimeRecord(live) && (live.mergeable === null || live.mergeable_state === "unknown"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, mergeabilityRetryDelayMs));
        signal.throwIfAborted();
        live = await readPull(repository, number, signal);
      }
      const liveReviews = await readRest(`repos/${repository}/pulls/${number}/reviews?per_page=100`, ".[]", signal);
      // GitHub reports a PR blocked by the failing required checks that the bypass merges past.
      const current = liveMergeReadiness(bypass && isRuntimeRecord(live) && live.mergeable === true && live.mergeable_state === "blocked" ? { ...live, mergeable_state: "unstable" } : live, decision.head, {
        automatedReviewSettled: reviewPushBudgetSpent(snapshot, waitPolicy),
        reviews: liveReviews.map(parseEvidence),
      });
      if (!current.ready) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: current.reason });
        // A base that requires up-to-date branches never merges a PR that is only behind it.
        if (!pending && current.reason === "mergeable_state behind") {
          if (!await updateBranch(owner, repository, number, decision.head, signal, live)) return "not-ready";
          schedulerEvent("babysitter.branch.updated", { ...owner, reason: "behind" });
          return await parkMerge(`Updated the branch with ${base} because ${base} requires up-to-date branches; waiting for checks on the new head.`);
        }
        return pending?.asynchronous ? await parkMerge(`Unconfirmed merge is waiting for ${current.reason}.`) : "not-ready";
      }
      if (!pending && isRuntimeRecord(live) && isRuntimeRecord(live.head) && hasRuntimeType(live.head.sha, "string") && isRuntimeRecord(live.base) && hasRuntimeType(live.base.ref, "string")) {
        // Checks test the base of their moment. When the base changed a file this PR touches since
        // then, both can pass alone and still break the base together, so retest on the current base.
        const overlap = await staleBaseOverlap(freshnessReader, snapshot, { head: { sha: live.head.sha }, base: { ref: live.base.ref } }, signal, bypass ? new Set(["success", ...failedConclusions]) : undefined);
        if (overlap.length) {
          const files = overlap.slice(0, 3).join(", ") + (overlap.length > 3 ? ` and ${overlap.length - 3} more` : "");
          schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: `${base} changed files this PR touches after its checks ran: ${files}` });
          if (!await updateBranch(owner, repository, number, decision.head, signal, live)) return "not-ready";
          schedulerEvent("babysitter.branch.updated", { ...owner, files: overlap.slice(0, 10) });
          return await parkMerge(`Updated the branch with ${base} because ${base} changed ${files} after its checks ran; waiting for checks on the new head.`);
        }
      }
      const repositorySettings = (await provider.repos.get(repo, { signal })).raw;
      const readChildren = () => readPulls(repository, { state: "open", base: snapshot.pr?.head?.ref ?? "", limit: 1_000 }, signal);
      const children = await readChildren();
      let branchSafety = directMergeBranchSafety(repositorySettings, live, children);
      // The repository deletes merged branches, so move the open children onto this PR's base before
      // merging it. Refusing left the parent and its children waiting on each other.
      const parentBase = isRuntimeRecord(live) && isRuntimeRecord(live.base) && hasRuntimeType(live.base.ref, "string") ? live.base.ref : undefined;
      if (!pending && parentBase && branchSafety === stackChildBaseDeletion) {
        const retargeted: number[] = [];
        try {
          for (const child of children) {
            if (!isRuntimeRecord(child) || String(child.state).toLowerCase() !== "open" || !isRuntimeRecord(child.base) || child.base.ref !== snapshot.pr?.head?.ref
              || !Number.isSafeInteger(child.number)) continue;
            // Persist before PATCH: a later retarget, lease check, or parent merge can fail.
            // Keep this across restarts and child head/base changes until GitHub confirms landing.
            await pullRequestInbox.setMeta(`stack-dependency:${repository}#${child.number}`, number);
            await provider.request("PATCH", `/repos/${repository}/pulls/${child.number}`, { body: { base: parentBase }, signal });
            retargeted.push(child.number as number);
          }
          branchSafety = directMergeBranchSafety(repositorySettings, live, await readChildren());
        }
        catch (error) {
          await noteForgeQuota(error, "stack-retarget");
          branchSafety = `stacked child retarget failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
        }
        if (retargeted.length) schedulerEvent("babysitter.stack.children_retargeted", { ...owner, children: retargeted, base: parentBase });
      }
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
      if (bypass && isRuntimeRecord(live)) {
        const proof = await verifyInheritedMerge(snapshot, live, signal);
        if ("refused" in proof) {
          schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: proof.refused });
          return pending?.asynchronous ? await parkMerge("Unconfirmed merge is waiting for inherited-check verification.") : "not-ready";
        }
        inheritedProof = proof;
        const verified = readiness(inheritedProof.fresh, inheritedProof.evaluation.state, inheritedProof.evaluation.inheritedCheckIds);
        if (!verified.ready) return await parkMerge(`Inherited-check bypass is waiting for ${verified.reason}.`);
      }
      signal.throwIfAborted();
      if (!pending && !(await pullRequestInbox.beginDirectMerge(claim, decision.head, true))) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "merge attempt already in flight or claim changed" });
        return "blocked";
      }
      if (inheritedProof) {
        const proof = { head: decision.head, base: inheritedProof.baseSha, checks: inheritedProof.evaluation.bypassedRequiredChecks,
          checkIds: inheritedProof.evaluation.inheritedCheckIds, verifiedAt: new Date().toISOString(), token: mergeToken };
        await pullRequestInbox.setMeta(`inherited-merge-proof:${repository}#${number}`, proof);
        schedulerEvent("babysitter.direct_merge.inherited_checks", { ...owner, ...proof });
      }
      mergeStarted = true;
      try {
        // GitHub's asynchronous merge with the expected head. A verified inherited failure merges past the branch rules.
        await forgeMerge(provider, pull(number), { method: merge.method, sha: decision.head, signal, bypassRules: Boolean(inheritedProof) });
      } catch (error) {
        if (!(error instanceof MergeBlockedError) || error.status === 409) throw error;
        if (mergeResultStatus(error) === "enqueued") {
          if (!await pullRequestInbox.recordDirectMergeEnqueued(repository, number, mergeToken)) throw new Error("Merge attempt changed before its enqueued result could be recorded.");
          return await parkMerge("GitHub enqueued the pull request; waiting for its merge webhook.");
        }
        await pullRequestInbox.clearDirectMerge(repository, number, mergeToken);
        return await parkMerge(`GitHub merge failed: ${error.message}`);
      }
    } catch (error) {
      await noteForgeQuota(error, "direct-merge");
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      // Definite HTTP rejections did not enqueue a merge. Keep the fence for
      // timeouts and transport failures, which may have delivered the request.
      // A 409 can name another pending merge request.
      const rejectedStatus = forgeErrorStatus(error);
      if (mergeStarted && rejectedStatus !== undefined && rejectedStatus >= 400 && rejectedStatus < 500 && rejectedStatus !== 409) await pullRequestInbox.clearDirectMerge(repository, number, mergeToken);
      return await parkMerge(`GitHub merge request failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    }
    await pullRequestInbox.clearDirectMerge(repository, number, mergeToken);
    await pullRequestInbox.finish(claim, {
      text: inheritedProof
        ? `Merged ${decision.head} directly past ${inheritedProof.evaluation.bypassedRequiredChecks.join(", ")}, which fail the same way on base ${inheritedProof.baseSha}; every other merge rule was satisfied.`
        : `Merged ${decision.head} directly: required checks passed and review threads were resolved.`,
      terminal: true,
    });
    schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: decision.head, avoided_invocation: true });
    return "merged";
  }

  /**
   * Proves from fresh GitHub reads that a bypass merge only skips inherited failures. The failures must
   * repeat on the base branch tip, where the merge lands: the PR's `base.sha` can be a day old and have no
   * CI runs (vitehub#3715). Every other branch rule must be known and satisfied. Returns why it cannot.
   */
  async function verifyInheritedMerge(snapshot: Snapshot, live: Record<string, unknown>, signal: AbortSignal): Promise<{ fresh: Snapshot; evaluation: InheritedCheckEvaluation; baseSha: string } | { refused: string }> {
    const { repository, number } = snapshot;
    const head = isRuntimeRecord(live.head) ? live.head.sha : undefined;
    const prBase = isRuntimeRecord(live.base) ? live.base : {};
    const base = prBase.ref;
    if (!hasRuntimeType(head, "string") || head !== snapshot.pr?.head?.sha || !hasRuntimeType(base, "string") || !/^[a-f\d]{40}$/i.test(String(prBase.sha))) return { refused: "Inherited-check bypass target changed." };
    const tip = await readOnePage(`repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`, signal);
    const baseSha = isRuntimeRecord(tip) && isRuntimeRecord(tip.object) ? tip.object.sha : undefined;
    if (!hasRuntimeType(baseSha, "string") || !/^[a-f\d]{40}$/i.test(baseSha)) return { refused: "Inherited-check bypass base tip unavailable." };
    const [owner, name] = repository.split("/");
    const [protection, rules, review, threads] = await Promise.all([
      // A branch without classic protection answers 404, and the bypass is then refused below.
      readOnePage(`repos/${repository}/branches/${encodeURIComponent(base)}/protection`, signal).catch(() => undefined),
      readRest(`repos/${repository}/rules/branches/${encodeURIComponent(base)}?per_page=100`, ".[]", signal),
      readGraphql(repository, signal)("query BabysitterInheritedMergeReview($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid reviewDecision}}}", { owner, name, number }),
      readThreads(repository, number, signal),
    ]);
    const data = isRuntimeRecord(review) && isRuntimeRecord(review.data) && isRuntimeRecord(review.data.repository) ? review.data.repository.pullRequest : undefined;
    if (!isRuntimeRecord(data) || isRuntimeRecord(review) && Array.isArray(review.errors) && review.errors.length || data.headRefOid !== head || data.baseRefOid !== prBase.sha) {
      return { refused: "Inherited-check bypass head or base changed during verification." };
    }
    const freshChecks = async () => {
      const [runs, statuses] = await Promise.all([
        readRest(`repos/${repository}/commits/${head}/check-runs?per_page=100`, ".check_runs[]", signal),
        readRest(`repos/${repository}/commits/${head}/statuses?per_page=100`, ".[]", signal),
      ]);
      return {
        checks: Object.fromEntries(runs.map(parseEvidence).map(check => [`check_run:${String(check.id)}`, check])),
        statuses: Object.fromEntries(statuses.map(parseEvidence).map((status, index) => [`status:${String(status.id ?? index)}`, { ...status, sha: head }])),
      };
    };
    let fresh: Snapshot = { ...snapshot, ...await freshChecks(), threads, threadsHydrated: true };
    const ids = new Set(await readInheritedBaseFailures(fresh, signal, baseSha));
    requiredChecks.invalidate(repository, base);
    const policy = await requiredChecks.read(repository, base);
    // Logs take time to download. A rerun must not reuse an older run's failure.
    fresh = { ...fresh, ...await freshChecks() };
    const evaluation = inheritedCheckEvaluation(fresh, policy, ids, waitPolicy.pendingReviewChecks, bypassChecksFor(repository));
    if (evaluation.state !== "passed" || !evaluation.bypassedRequiredChecks.length) return { refused: "Fresh checks do not justify an inherited-check bypass." };
    const ancestry = await readOnePage(`repos/${repository}/compare/${baseSha}...${head}?per_page=1`, signal);
    const safety = inheritedBypassSafety({ protection, rules, reviewDecision: data.reviewDecision ?? null, threadsResolved: threads.every(thread => thread.isResolved === true),
      method: merge.mode === "direct" ? merge.method : "squash", upToDate: isRuntimeRecord(ancestry) && ancestry.behind_by === 0 });
    if (safety !== true) return { refused: `Inherited-check bypass refused: ${safety}.` };
    return { fresh, evaluation, baseSha };
  }

  /**
   * When to check the merge gates of a reviewed head again. Webhooks and change detection already wake
   * the PR on new checks, reviews, and pushes, so this timer only covers gates that no event reports.
   * Each retry on the same head doubles the delay: a fixed two minutes cost 30 passes and their GitHub
   * requests an hour for every PR that waits on CI or a person.
   */
  async function mergeRetryAt(snapshot: Snapshot): Promise<number> {
    const key = `merge-retry:${snapshot.repository}#${snapshot.number}`;
    const head = snapshot.pr?.head?.sha;
    const previous = await pullRequestInbox.meta(key);
    const delayMs = isRuntimeRecord(previous) && previous.head === head && hasRuntimeType(previous.delayMs, "number")
      ? Math.min(previous.delayMs * 2, mergeRetryMaxMs)
      : mergeRetryMinMs;
    await pullRequestInbox.setMeta(key, { head, delayMs });
    return Date.now() + delayMs;
  }

  const postPushGraceMs = options.postPushGraceMs ?? 3 * 60_000;

  /** The push receipt of a pass. `reviewDriven` comes from the claimed snapshot, never from the model. */
  function pushProgress(head: string, reviewDriven: boolean): ProgressOutcome {
    return { kind: "verified", evidence: `push:${head}`, ...reviewDriven ? { reviewDriven: true } : {} };
  }

  async function parkOnPushedHead(claim: Claim, text: string, head: string, verifiedPushHeads: readonly string[], wait: BabysitterPassResult["wait"] | undefined, reviewDriven: boolean) {
    const current = await pullRequestInbox.get(claim.snapshot.repository, claim.snapshot.number);
    const progress = pushProgress(head, reviewDriven);
    // Include this worker's verified resolutions, but leave concurrent, unseen feedback unacknowledged.
    // The wait sees the review push record after this push, so a push that spends the budget parks on
    // the feedback that the spent budget still counts.
    const observed = { ...claim.snapshot, ...reviewPushBudget === false ? {} : { reviewPushBudget: nextReviewPushBudget(current?.reviewPushBudget, reviewPushBudget, progress, claim.snapshot.pr?.head?.sha) }, threads: claim.snapshot.threads.map(thread => {
      const latest = current?.threads.find(value => String(value.node_id ?? value.id) === String(thread.node_id ?? thread.id));
      return latest?.resolutionSource === "worker" && latest.isResolved === true
        ? { ...thread, isResolved: true, resolutionSource: latest.resolutionSource, resolutionObservedAt: latest.resolutionObservedAt } : thread;
    }) };
    let waiting = createCheckWait(observed, waitPolicy);
    if (wait?.kind === "external") {
      await pullRequestInbox.setMeta(`review-assessment:${observed.repository}#${observed.number}`, null);
      // Wake setup is best effort; an unavailable dependency must never remove the blocker.
      const allowedWake = wait.wake && repositorySource.known().includes(wait.wake.repository.toLowerCase()) ? wait.wake : undefined;
      waiting = { ...waiting, kind: "external", reason: wait.reason, ...(allowedWake ? { wake: allowedWake } : {}) };
      try {
        waiting = await externalWait(observed, wait.wake, wait.reason);
      } catch (error) {
        schedulerEvent("babysitter.external_wait.setup_failed", { repository: observed.repository, pull_request: observed.number,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return await pullRequestInbox.finish(claim, { text, progress, verifiedPushHeads,
      wait: { ...waiting, headSha: head } });
  }

  /** Retries a provider rate limit `providerRetries` times, then opens an escalating model cooldown. */
  async function runWithProviderRetry<T>(run: () => Promise<T>, signal: AbortSignal, onRateLimit?: () => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await run();
        await providerQuota.succeeded();
        return result;
      } catch (error) {
        if (isAbortError(error) || !isProviderRateLimit(error)) throw error;
        onRateLimit?.();
        if (attempt >= providerRetries) {
          await providerQuota.block();
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, providerRetryDelayMs));
        signal.throwIfAborted();
      }
    }
  }
  const providerRetryDelayMs = options.providerRetryDelayMs ?? 10_000;
  const providerRetries = presetOptions.providerRetries ?? 3;
  const mergeabilityRetryDelayMs = options.mergeabilityRetryDelayMs ?? 3000;

  /** A GitHub rate limit stops every forge request until it resets. Returns whether the error was one. */
  async function noteForgeQuota(error: unknown, operation: string): Promise<boolean> {
    if (!(error instanceof RateLimitedError)) return false;
    const until = await forgeQuota.block(error.resetAt?.getTime());
    schedulerEvent("babysitter.forge.quota.blocked", { operation, blocked_until: new Date(until).toISOString(),
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    return true;
  }

  /** The required-check evaluation with the PR's own failing Actions counted and the base's failures attributed to the base. */
  async function checkEvaluation(snapshot: Snapshot, policy: GitHubRequiredCheckPolicy, signal: AbortSignal): Promise<InheritedCheckEvaluation> {
    const evaluation = evaluateGitHubRequiredChecks(policy, snapshotCheckEvidence(snapshot));
    if (evaluation.state === "unknown" || !failedOwnActions(snapshot, waitPolicy.pendingReviewChecks).length) return { ...evaluation, inheritedCheckIds: [], bypassedRequiredChecks: [] };
    const inherited = new Set(await inheritedBaseFailures(snapshot, signal));
    return inheritedCheckEvaluation(snapshot, policy, inherited, waitPolicy.pendingReviewChecks, bypassChecksFor(snapshot.repository));
  }

  async function requiredCheckEvaluation(snapshot: Snapshot, signal: AbortSignal = AbortSignal.timeout(120_000)) {
    const base = snapshot.pr?.base?.ref;
    if (!base) return undefined;
    return await checkEvaluation(snapshot, await requiredChecks.read(snapshot.repository, base), signal);
  }

  async function requiredCheckState(snapshot: Snapshot, signal?: AbortSignal) {
    return (await requiredCheckEvaluation(snapshot, signal))?.state ?? "unknown";
  }

  /** Times of the PR's repair pushes in the last 24 hours, kept while `dailyPushBudget` is set. */
  async function repairPushTimes(snapshot: Snapshot): Promise<number[]> {
    const pushes = await pullRequestInbox.meta(`repair-pushes:${snapshot.repository}#${snapshot.number}`);
    return Array.isArray(pushes) ? pushes.filter(at => hasRuntimeType(at, "number") && at > Date.now() - 24 * 60 * 60_000) : [];
  }

  /** Whether a pass may push now under `dailyPushBudget`, or undefined without that budget. */
  async function repairPushWindow(snapshot: Snapshot, requiredChecks: string, conflicted: boolean) {
    if (dailyPushBudget === false) return undefined;
    return repairPushAllowance(await repairPushTimes(snapshot), dailyPushBudget, { requiredChecks, conflicted, priority: pullRequestInbox.isPriority(snapshot.pr), now: Date.now() });
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

  /** Fingerprints of the feedback that explicit assessments of this PR covered. */
  async function assessedFeedback(snapshot: Snapshot): Promise<Set<string>> {
    const saved = await pullRequestInbox.meta(`review-assessment:${snapshot.repository}#${snapshot.number}`);
    return new Set(isRuntimeRecord(saved) && saved.version === 2 && Array.isArray(saved.feedback) ? saved.feedback.filter(item => hasRuntimeType(item, "string")) : []);
  }

  /**
   * Why a pass waits for running gates, or undefined when it runs now. A conflict always runs now.
   * Checks that still run on the current head defer a pass even beside a failure: a pass that started
   * on a fast lint failure missed the findings of the checks and reviews that finished later.
   */
  async function pendingGateDeferral(snapshot: Snapshot): Promise<string | undefined> {
    if (!deferWhilePending) return undefined;
    const pr = snapshot.pr;
    if (!pr || pr.mergeable === false || pr.mergeable_state === "dirty") return undefined;
    if (checksStillRunning(snapshot, Date.now(), waitPolicy)) return reviewCheckRunning(snapshot, waitPolicy) ? "review checks" : "running checks";
    if (failureKeys(snapshot).length) return undefined;
    if (reviewCheckRunning(snapshot, waitPolicy)) return "review checks";
    const evaluation = await requiredCheckEvaluation(snapshot);
    // A required check that never reported may never run, so only running checks defer a pass.
    return evaluation?.state === "pending" && !evaluation.missing.length ? "required checks" : undefined;
  }

  const installOption = baseAgent.install ?? presetOptions.install ?? true;
  const installer = createBabysitterInstaller(installOption);
  const installRequired = isRuntimeRecord(installOption) && installOption.required === true;
  const refreshLimit = isRuntimeRecord(installOption) ? installOption.refreshes : undefined;
  // A waiting pass keeps its checkout, so it waits longer than the default two minutes.
  const installSlots = createGitHubInstallSlots({ concurrency: (isRuntimeRecord(installOption) ? installOption.concurrency : undefined) ?? 2, queueTimeoutMs: 10 * 60_000 });

  /** Whether the host install of this checkout failed or never ran, for example while installer capacity stayed busy. */
  async function installFailed(directory: string): Promise<boolean> {
    const record: unknown = await readFile(join(directory, ".git", "vitehub-install.json"), "utf8").then(text => JSON.parse(text), () => undefined);
    return record === undefined || isRuntimeRecord(record) && record.status === "failed";
  }

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
    }, { slots: installSlots });
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
      const pr = await readPull(wake.repository, wake.number);
      if (!isRuntimeRecord(pr)) throw new Error("Missing external pull-request state.");
      return digest({ state: pr.state, mergedAt: pr.merged_at, head: isRuntimeRecord(pr.head) ? pr.head.sha : undefined });
    }
    const { provider, repo } = await forge(wake.repository);
    return checksDependencyEvidence(await provider.checks.list(repo, wake.headSha));
  }
  /**
   * Only a wait for another pull request ends by itself, when it merges or closes. Every other external
   * blocker gets a fresh pass after two hours: on 2026-10-19 about 45 PRs sat in external waits for
   * 13 hours or more, 30 of them on an install error the host had already fixed, and one waited on the
   * checks of a main commit 90 commits back, which never change. A host defect is the exception: only a
   * new worker release fixes it, and that release wakes the wait.
   */
  async function externalWait(observed: Snapshot, wake: PullRequestWake | undefined, reason: string) {
    const retryAt = Date.now() + externalRetryMs;
    if (!wake) {
      await statusRecovery.recordWorkerBlocker(observed, reason);
      const wait = { ...createCheckWait(observed, waitPolicy), kind: "external" as const, reason };
      return isWorkerBlocker({ lastResult: observed.lastResult, wait: { ...wait, headSha: observed.pr?.head?.sha ?? "" } }) ? wait : { ...wait, retryAt };
    }
    if (!repositorySource.known().includes(wake.repository.toLowerCase())) throw new Error("External wake repository is outside the configured repositories.");
    const evidence = await dependencyEvidence(wake);
    await pullRequestInbox.setMeta(`dependency:${observed.repository}#${observed.number}`, evidence);
    const otherPullRequest = wake.kind === "pull-request"
      && !(wake.repository.toLowerCase() === observed.repository.toLowerCase() && wake.number === observed.number);
    return { ...createCheckWait(observed, waitPolicy), kind: "external" as const, reason, wake, ...otherPullRequest ? {} : { retryAt } };
  }

  async function recoverFailedCiWaits() {
    for (const snapshot of await pullRequestInbox.waitsToEvaluate(false, true)) {
      if (snapshot.generation > snapshot.handled || isWorkerBlocker(snapshot) || !hasFailedActions(snapshot)) continue;
      const head = snapshot.pr?.head?.sha;
      if (!head) continue;
      // A spent same-head budget refuses model work until its cooldown retry, so a recovery pass would only
      // park again. On 2026-10-31 three PRs did that every ten minutes.
      if (snapshot.progressBudget?.exhausted && snapshot.progressBudget.head === head && (snapshot.wait?.retryAt ?? 0) > Date.now()) continue;
      const recoveryKey = `ci-recovery-next:${snapshot.repository}#${snapshot.number}:${head}`;
      if ((await pullRequestInbox.metaNumber(recoveryKey) ?? 0) > Date.now()) continue;
      await pullRequestInbox.setMeta(recoveryKey, Date.now() + 10 * 60_000);
      if (await pullRequestInbox.wake(snapshot, `ci-recovery:${head}`, { recovery: true })) {
        schedulerEvent("babysitter.ci.recovery.woken", { repository: snapshot.repository, pull_request: snapshot.number, head_sha: head });
      }
    }
  }

  /**
   * A parked PR on another PR's branch gets no event when that parent merges, so read its parents every
   * ten minutes. On 2026-10-31 a child sat parked on its parent's branch two days after the parent merged.
   */
  async function stackParentMerged(snapshot: Snapshot): Promise<boolean> {
    const target = snapshot.pr && !snapshot.wait?.wake ? nonDefaultBase(snapshot.pr) : undefined;
    if (!snapshot.pr || !target) return false;
    const nextReadKey = `stack-parent-next:${snapshot.repository}#${snapshot.number}`;
    if (((await pullRequestInbox.metaNumber(nextReadKey)) ?? 0) > Date.now()) return false;
    await pullRequestInbox.setMeta(nextReadKey, Date.now() + 10 * 60_000);
    try {
      const parents = await readPulls(snapshot.repository, { state: "all", head: `${target.owner}:${target.base}`, limit: 10 });
      return stackRetargetBase(snapshot.pr, parents) !== undefined;
    } catch (error) {
      await noteForgeQuota(error, "stack-parent");
      return false;
    }
  }

  /** The unresolved review threads a worker declined while their reviewer labeled them P0 or P1. */
  async function heldOpenThreads(snapshot: Snapshot): Promise<Set<string>> {
    const saved = await pullRequestInbox.meta(heldThreadsKey(snapshot.repository, snapshot.number));
    const held = new Set(Array.isArray(saved) ? saved.filter(item => hasRuntimeType(item, "string")) : []);
    return new Set(snapshot.threads.filter(thread => thread.isResolved !== true).map(thread => String(thread.node_id ?? thread.id)).filter(id => held.has(id)));
  }

  /** Wakes a parked PR only when its new events need a model pass or a direct merge. */
  async function evaluateWaits() {
    // Idle waits too: a parked stack child has no event, wake or retryAt that would list it.
    for (const snapshot of await pullRequestInbox.waitsToEvaluate(true, true)) {
      const parentMerged = await stackParentMerged(snapshot);
      if (!parentMerged && snapshot.generation <= snapshot.handled && (snapshot.wait?.retryAt ?? Infinity) > Date.now() && !snapshot.wait?.wake) continue;
      const checks = await requiredCheckState(snapshot);
      let reasons = wakeReasons(snapshot, checks, { ...waitPolicy, heldThreads: await heldOpenThreads(snapshot) });
      if (parentMerged) reasons.push("stack-parent-merged");
      if (snapshot.wait?.reason === "non-default-base" && snapshot.pr && !nonDefaultBase(snapshot.pr)) reasons.push("base-retargeted");
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
    const dependency = await pullRequestInbox.metaNumber(`stack-dependency:${snapshot.repository}#${snapshot.number}`);
    if (dependency !== undefined) {
      const parent = await readPull(snapshot.repository, dependency, signal);
      if (!isRuntimeRecord(parent) || !(parent.merged === true || hasRuntimeType(parent.merged_at, "string"))) return { parent: dependency };
    }
    const target = pr && nonDefaultBase(pr);
    if (!pr || !target) return undefined;
    const { base, owner } = target;
    const parents = await readPulls(snapshot.repository, { state: "all", head: `${owner}:${base}`, limit: 10 }, signal);
    const to = stackRetargetBase(pr, parents);
    if (!to) {
      const parent = parents.find(value => isRuntimeRecord(value) && String(value.state).toLowerCase() === "open" && Number.isSafeInteger(value.number));
      return isRuntimeRecord(parent) && hasRuntimeType(parent.number, "number") ? { parent: parent.number } : undefined;
    }
    const live = await readPull(snapshot.repository, snapshot.number, signal);
    if (!isRuntimeRecord(live) || String(live.state).toLowerCase() !== "open"
      || !isRuntimeRecord(live.base) || live.base.ref !== base
      || !isRuntimeRecord(live.head) || live.head.sha !== pr.head?.sha
      || !await pullRequestInbox.isClaimCurrent(claim)) {
      await pullRequestInbox.hydrate(claim, { refresh: true });
      throw new DOMException("Stack child changed before retargeting.", "AbortError");
    }
    signal.throwIfAborted();
    try {
      const { provider, pull } = await forge(snapshot.repository, signal);
      await retargetPullRequest(provider, pull(snapshot.number), to, { signal });
    } catch (error) {
      // A stale stack snapshot can race a webhook or another worker. GitHub
      // may reject a redundant retarget even though the desired base is live.
      const current = await readPull(snapshot.repository, snapshot.number, signal);
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
    const { publicUrl } = options;
    if (!isAccepting()) return;
    // A GitHub rate limit stops every forge request until it resets. The breaker is durable inbox
    // metadata and the forge error paths below renew it.
    const forgeBlockedUntil = await forgeQuota.blockedUntil();
    if (forgeBlockedUntil > Date.now()) {
      schedulerEvent("babysitter.forge.quota.waiting", { reason, blocked_until: new Date(forgeBlockedUntil).toISOString() });
      return;
    }
    await statusRecovery.recover();
    void track(statusRecovery.flush().catch(failure => schedulerError("babysitter.status.flush.failed", failure)));
    let modelAdmission = true;
    // Token budgets limit only the model. Other closed admission, such as memory or tmp pressure, holds host work too.
    let hostAdmission = true;
    let modelRetryAt: number | undefined;
    if (options.admission) {
      const admission = await options.admission();
      if (!admission.accepting) {
        modelAdmission = false;
        hostAdmission = admission.reason === "token-budget-hourly" || admission.reason === "token-budget-daily";
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
    // An installation list that cannot be read keeps the last one; work in known repositories continues.
    const repositories = await repositorySource.current().catch(async (error: unknown) => {
      await noteForgeQuota(error, "repositories");
      schedulerError("babysitter.repositories.failed", error, { source: repositorySource.source });
      return repositorySource.known();
    });
    // Event-scoped filters cannot be established from the pull-request REST
    // listing alone.  Seeding those entries would admit PRs that have never
    // produced an allowed event (for example, `action: synchronize`).
    const eventScopedBootstrap = Boolean(filter.actor || filter.action);
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
        // forges `threads.list()` also reads the checks of every listed pull request.
        const prs = await readPulls(repository, { state: "open", limit: 10_000 });
        for (const pr of prs) await pullRequestInbox.seed(repository, normalizePullRequest(pr));
        await pullRequestInbox.setMeta(key, { at: new Date().toISOString() });
      } catch (error) {
        await noteForgeQuota(error, "bootstrap");
        schedulerError("babysitter.bootstrap.failed", error, { repository });
      }
    }
    await checkMainRepairs(repositories, track);
    try {
      // One open-PR query per repository and minute finds lost deliveries; only changed PRs are probed.
      await detectChangedPullRequests(pullRequestInbox, repository => readGraphql(repository), repositories, Date.now(), !eventScopedBootstrap);
    } catch (error) {
      await noteForgeQuota(error, "snapshot-detect");
      schedulerError("babysitter.snapshot.detect.failed", error);
    }
    try {
      await probeChangedSnapshots(pullRequestInbox, readRest, Date.now(), readThreads, activityAuthors);
      // The slow sweep remains for changes the fingerprint cannot see, such as edited comments.
      await reconcileOneSnapshot(pullRequestInbox, readRest, Date.now(), readThreads, activityAuthors);
    } catch (error) {
      await noteForgeQuota(error, "snapshot-reconcile");
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
      await noteForgeQuota(error, "wait-evaluate");
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
    const forgeBlockedAfterReconcile = await forgeQuota.blockedUntil();
    if (forgeBlockedAfterReconcile > Date.now()) {
      schedulerEvent("babysitter.forge.quota.waiting", { reason, blocked_until: new Date(forgeBlockedAfterReconcile).toISOString() });
      return;
    }
    // A model cooldown pauses model passes only. Host work still merges ready PRs and retargets
    // stacks; PRs that need a model pass are released unchanged until their evidence changes.
    const providerBlockedUntil = await providerQuota.blockedUntil();
    if (providerBlockedUntil > Date.now() && modelAdmission) {
      modelAdmission = false;
      modelRetryAt = providerBlockedUntil;
      schedulerEvent("babysitter.provider.quota.host_only", { reason, blocked_until: new Date(providerBlockedUntil).toISOString() });
    }
    // After rate limits, model passes resume at half concurrency per strike. Host-only work ignores the model cap.
    // Claim up to the owner capacity regardless of the model cap: host-only merges and
    // stack retargets must continue while model admission is reduced or paused.
    const claimLimit = ownerLimit;
    // Every claimed owner occupies a host slot while it performs checkout,
    // placement, installation, or waits for model admission. Keep waiters in
    // this count so concurrent reconciles cannot claim past the owner limit.
    const hostActive = active.size;
    const placementAdmitted = presetOptions.placement?.admitted ? await presetOptions.placement.admitted() : Number.POSITIVE_INFINITY;
    // An invalid count claims nothing: claiming past the hosts only turns each PR away at placement.
    const placementLimit = typeof placementAdmitted === "number" && placementAdmitted >= 0 ? placementAdmitted : 0;
    const remainingCapacity = Math.max(0, Math.min(claimLimit, placementLimit) - hostActive);
    const lane = await pullRequestInbox.claim(Math.min(5, remainingCapacity), {
      only: snapshot => Boolean(snapshot.recoveryHead && snapshot.recoveryHead === snapshot.pr?.head?.sha),
      includeBlocked: true,
      skip: snapshot => !modelAdmission && hostOnlyChecked.get(`${snapshot.repository}#${snapshot.number}`) === hostOnlyStamp(snapshot),
    });
    // Admission limits model dispatch. Merges and stack retargets remain host work,
    // also on a head whose no-progress budget is exhausted: the claim parks before
    // any model work, so new evidence can still merge the PR.
    const regularCapacity = Math.max(0, remainingCapacity - lane.length);
    const regular = await pullRequestInbox.claim(regularCapacity, { skip: snapshot => !modelAdmission && hostOnlyChecked.get(`${snapshot.repository}#${snapshot.number}`) === hostOnlyStamp(snapshot) });
    const exhausted = await pullRequestInbox.claim(Math.max(0, regularCapacity - regular.length), {
      includeBlocked: true,
      only: snapshot => snapshot.progressBudget?.exhausted === true && snapshot.progressBudget.head === snapshot.pr?.head?.sha,
      skip: snapshot => !modelAdmission && hostOnlyChecked.get(`${snapshot.repository}#${snapshot.number}`) === hostOnlyStamp(snapshot),
    });
    const jobs = [...lane, ...regular, ...exhausted];
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
        const passResultSchema = createBabysitterPassResultSchema(diagnostic => {
          schedulerEvent("babysitter.result.normalized", { ...owner, ...diagnostic });
        });
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
        // A host-owned provider workspace for a conflicting PR without a kept workspace. The pass removes it.
        let conflictWork: string | undefined;
        let placementLease: BabysitterPlacementLease | undefined;
        // The PR's kept workspace, and what this pass leaves in it for the next one.
        let workspaceEntry: PullRequestWorkspaceEntry | undefined;
        const workspaceRun: { prepared: boolean; ok: boolean; head?: string; base?: string; reason?: string; durationMs?: number; session?: { resume: boolean; reason: string }; thread?: string } = { prepared: false, ok: false };
        let dependencyRefreshes = 0;
        // A pass placed in a Sandbox installs there; the host checkout keeps no dependencies.
        const hostInstall = () => presetOptions.install !== false && !placementLease?.sandbox;
        let modelWorkParked = false;
        let modelDispatched = false;
        // A provider rate limit is infrastructure, not a failed repair, so it never spends the head's budget.
        let providerLimited = false;
        const parkBlockedModelWork = async () => {
          const currentAdmission = await options.admission?.();
          const retryAt = currentAdmission && !currentAdmission.accepting
            ? currentAdmission.retryAt ?? Date.now() + 60_000 : modelRetryAt;
          const providerBlockedUntil = (await pullRequestInbox.metaNumber("provider-quota-blocked-until")) ?? 0;
          const providerBlocked = providerBlockedUntil > Date.now();
          const admitted = (currentAdmission?.accepting ?? modelAdmission) && !providerBlocked;
          if (babysitterModelAdmission(admitted, inboxClaim.snapshot)) return await parkUnrelatedFailures() || await parkSpentReviewPushBudget() || await parkClosedPushWindow() || await parkSpentDailyPassBudget();
          modelWorkParked = true;
          outcome = "waiting";
          await pullRequestInbox.finish(inboxClaim, {
            text: providerBlocked
              ? `CI reconciliation completed; provider quota cooldown ends at ${new Date(providerBlockedUntil).toISOString()}.`
              : admitted
                ? "CI reconciliation completed; the same-head repair budget is exhausted."
                : "CI reconciliation completed; model work is waiting for host admission.",
            ...(pushedHead ? { progress: pushProgress(pushedHead, reviewDrivenPush()), verifiedPushHeads: [...verifiedPushHeads] } : {}),
            wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy),
              ...(pushedHead ? { headSha: pushedHead } : {}),
              retryAt: admitted ? undefined : Math.max(retryAt ?? 0, providerBlocked ? providerBlockedUntil : 0) },
          });
          return true;
        };
        /**
         * Parks the claim before its first model dispatch when its required checks fail only because the
         * base fails them the same way, or because a runner or network error stopped them. No pass, push or
         * budget is spent on them. A conflict, a person's feedback or a person's open thread still gets a pass.
         */
        const parkUnrelatedFailures = async () => {
          if (modelDispatched || pushedHead || merge.mode !== "direct") return false;
          if (pullRequestInbox.isMainRepair(inboxClaim.snapshot.pr)) return false;
          const snapshot = inboxClaim.snapshot;
          if (conflicted(snapshot) || (snapshot.humanFeedbackGeneration ?? 0) > snapshot.handled) return false;
          if (snapshot.threads.some(thread => thread.isResolved !== true && hasHumanComment(thread, waitPolicy.workerAuthors))) return false;
          // An optional failure only needs the pass that assesses it before the PR can merge.
          if (await requiredCheckState(snapshot, passSignal) !== "failed") return false;
          const unrelated = unrelatedFailureWait(await failureCauses(snapshot, passSignal), snapshot.pr?.base?.ref ?? "the base");
          if (!unrelated) return false;
          modelWorkParked = true;
          outcome = "waiting";
          if (unrelated.infrastructure && await retestInfrastructureFailure(snapshot, owner, passSignal)) {
            await pullRequestInbox.finish(inboxClaim, { text: `${unrelated.reason} Updated the branch with ${snapshot.pr?.base?.ref} for a fresh CI run.`, wait: createCheckWait(snapshot, waitPolicy) });
            schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: snapshot.pr?.head?.sha, avoided_invocation: true, reason: "infrastructure-retest" });
            return true;
          }
          await pullRequestInbox.finish(inboxClaim, { text: unrelated.reason, wait: { ...createCheckWait(snapshot, waitPolicy), reason: "unrelated-ci-failure", retryAt: unrelated.retryAt } });
          schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: snapshot.pr?.head?.sha, avoided_invocation: true, reason: "unrelated-ci-failure", checks: unrelated.checks });
          return true;
        };
        // A push answers review when the claimed PR had no conflict and no failure outside the review checks.
        const reviewDrivenPush = () => !installDefect && pushCause(inboxClaim.snapshot, waitPolicy) === "review";
        /**
         * Parks the claim before its first model dispatch when the PR spent its review push budget and
         * only automated review is left. A person, a conflict, another failing check or a new head still
         * gets a pass.
         */
        const parkSpentReviewPushBudget = async () => {
          if (modelDispatched || pushedHead || reviewPushBudget === false || !reviewPushBudgetSpent(inboxClaim.snapshot, waitPolicy)) return false;
          const work = reviewPushBudgetWork(inboxClaim.snapshot, waitPolicy, await assessedFeedback(inboxClaim.snapshot));
          if (work.length) {
            schedulerEvent("babysitter.review_push_budget.pass", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, work });
            return false;
          }
          modelWorkParked = true;
          outcome = "waiting";
          const pushes = inboxClaim.snapshot.reviewPushBudget?.count ?? 0;
          const minorHeads = inboxClaim.snapshot.reviewPushBudget?.minorHeads?.length ?? 0;
          const checks = waitPolicy.pendingReviewChecks.size ? `failed ${[...waitPolicy.pendingReviewChecks].join(", ")} checks` : "failed review checks";
          const spent = minorReviewRounds !== false && minorHeads >= minorReviewRounds
            ? `Automated review settled: ${minorHeads} heads in a row had no finding above P2 (minorReviewRounds ${minorReviewRounds})`
            : `Review push budget spent: ${pushes} review-driven push${pushes === 1 ? "" : "es"} (reviewPushBudget ${reviewPushBudget})`;
          await pullRequestInbox.finish(inboxClaim, {
            text: `${spent}. Bot feedback and ${checks} no longer start a pass${merge.mode === "direct" ? "; the PR merges when its required checks pass" : ""}. A person's comment or review, another failing check, a merge conflict or a head pushed by someone else resumes it.`,
            wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), reason: "review-push-budget" },
          });
          schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, avoided_invocation: true, reason: "review-push-budget" });
          return true;
        };
        /**
         * Parks the claim before its first model dispatch when required checks fail and `dailyPushBudget`
         * refuses a push until later: such a pass could only build a commit that the push gate refuses.
         * A conflict or a person's feedback still gets a pass.
         */
        const parkClosedPushWindow = async () => {
          if (modelDispatched || pushedHead || dailyPushBudget === false) return false;
          const snapshot = inboxClaim.snapshot;
          if (snapshot.pr?.mergeable === false || snapshot.pr?.mergeable_state === "dirty" || (snapshot.humanFeedbackGeneration ?? 0) > snapshot.handled) return false;
          if (await requiredCheckState(snapshot) !== "failed") return false;
          const window = await repairPushWindow(snapshot, "failed", false);
          if (!window || window.allowed) return false;
          modelWorkParked = true;
          outcome = "waiting";
          const resumeAt = new Date(window.nextAt).toISOString();
          await pullRequestInbox.finish(inboxClaim, {
            text: `Daily push budget spent: ${window.count} repair pushes in the last 24 hours (dailyPushBudget ${dailyPushBudget}). Required checks fail, so the next repair push and pass can start at ${resumeAt}. A person's comment or review or a merge conflict still starts a pass.`,
            wait: { ...createCheckWait(snapshot, waitPolicy), reason: "daily-push-budget", retryAt: window.nextAt + 60_000 },
          });
          schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: snapshot.pr?.head?.sha, avoided_invocation: true, reason: "daily-push-budget", resume_at: resumeAt });
          return true;
        };
        // The exemption that let this pass run past its daily pass budget. Dispatch records it once.
        let dailyPassExemptionUsed: string | undefined;
        /**
         * Parks the claim before its first model dispatch when `dailyPassBudget` passes started in the
         * last 24 hours, until the oldest leaves the window. Exempt work still gets a pass.
         */
        const parkSpentDailyPassBudget = async () => {
          if (modelDispatched || pushedHead || dailyPassBudget === false) return false;
          const now = Date.now();
          const budget = (await pullRequestInbox.get(repository, number))?.dailyPassBudget;
          const resumeAt = dailyPassResumeAt(budget, dailyPassBudget, now);
          if (resumeAt === undefined) return false;
          if (pullRequestInbox.isPriority(inboxClaim.snapshot.pr)) {
            schedulerEvent("babysitter.daily_pass_budget.exempt", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, exemption: "priority-label" });
            return false;
          }
          const requiredChecks = await requiredCheckState(inboxClaim.snapshot);
          const window = requiredChecks === "failed" ? await repairPushWindow(inboxClaim.snapshot, requiredChecks, false) : undefined;
          const openPushWindow = window?.allowed ? Math.max(0, ...await repairPushTimes(inboxClaim.snapshot)) : undefined;
          const exemption = dailyPassExemption(inboxClaim.snapshot, requiredChecks, budget, openPushWindow);
          if (exemption) {
            dailyPassExemptionUsed = exemption;
            schedulerEvent("babysitter.daily_pass_budget.exempt", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, exemption });
            return false;
          }
          modelWorkParked = true;
          outcome = "waiting";
          const passes = budget?.passes.filter(at => at > now - 24 * 60 * 60_000).length ?? 0;
          await pullRequestInbox.finish(inboxClaim, {
            text: `Daily pass budget spent: ${passes} model pass${passes === 1 ? "" : "es"} in the last 24 hours (dailyPassBudget ${dailyPassBudget}). The next pass can start at ${new Date(resumeAt).toISOString()}. A person's comment or review, the first failing required check on a head, a head whose required checks pass, or a merge conflict still starts a pass.`,
            wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), reason: "daily-pass-budget", retryAt: resumeAt },
          });
          schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, avoided_invocation: true, reason: "daily-pass-budget", resume_at: new Date(resumeAt).toISOString() });
          return true;
        };
        const preparedDirectories = new Set<string>();
        // A frozen install rejected this head's lockfile. The next pass on the same head runs on this
        // host, starts without dependencies and gets the error, so the model repairs the lockfile.
        const installDefectKey = `install-defect:${repository}#${number}`;
        const recordedDefect = await pullRequestInbox.meta(installDefectKey);
        let installDefect = isRuntimeRecord(recordedDefect) && recordedDefect.head === inboxClaim.snapshot.pr?.head?.sha && hasRuntimeType(recordedDefect.error, "string") ? recordedDefect.error : undefined;
        const installFailure = (error: Error) => error.message.split("\n").filter(line => !/cyclic workspace dependencies|^\s+\//.test(line)).join("\n");
        const handInstallDefect = async (error: Error, wait: { retryAt?: number }) => {
          // Hand the defect to one model pass per head instead of waiting for a person to push.
          const head = inboxClaim.snapshot.pr?.head?.sha;
          if (installDefect || !head) return;
          await pullRequestInbox.setMeta(installDefectKey, { head, error: installFailure(error).slice(-3000) });
          wait.retryAt = Date.now() + 60_000;
        };
        // The claimed PR conflicts and nothing else needs the model, so the host may push the merge it resolves.
        let hostConflictPush = false;
        const hostConflictKey = `host-conflict:${repository}#${number}`;
        /**
         * Why a conflicting PR needs a model pass besides its conflict, or undefined without a conflict. A head
         * and base the host already failed to resolve alone, a push window that would refuse a push without the
         * conflict (it bounds a re-conflict loop to the daily push budget), and admission closed by host pressure
         * rather than a token budget all leave the conflict to the normal model pass.
         */
        const hostConflictBlockers = async (): Promise<string[] | undefined> => {
          const snapshot = inboxClaim.snapshot;
          if (snapshot.pr?.mergeable !== false && snapshot.pr?.mergeable_state !== "dirty") return undefined;
          const requiredChecks = await requiredCheckState(snapshot, passSignal);
          const blockers = conflictOnlyBlockers(snapshot, requiredChecks, { ...waitPolicy, heldThreads: await heldOpenThreads(snapshot) }, await assessedFeedback(snapshot));
          if (pullRequestInbox.isMainRepair(snapshot.pr)) blockers.push("main-repair");
          if (installDefect) blockers.push("install-defect");
          const tried = await pullRequestInbox.meta(hostConflictKey);
          if (isRuntimeRecord(tried) && tried.head === snapshot.pr?.head?.sha && tried.base === snapshot.pr?.base?.sha) blockers.push("host-resolution-tried");
          const window = await repairPushWindow(snapshot, requiredChecks, false);
          if (window && !window.allowed) blockers.push("push-window");
          if (!hostAdmission) blockers.push("host-admission");
          return blockers;
        };
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
              passSignal,
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
          const stackParent = retargeted && "parent" in retargeted ? retargeted.parent : undefined;
          const parkOnStackParent = async (parent: number, text: string) => {
            await pullRequestInbox.finish(inboxClaim, { text,
              wait: await externalWait(inboxClaim.snapshot, { kind: "pull-request", repository, number: parent }, "stack-parent") });
            schedulerEvent("babysitter.stack.waiting", { ...owner, parent });
          };
          if (stackParent !== undefined && !repairStackChildren) {
            await parkOnStackParent(stackParent, `Waiting for open parent PR #${stackParent} before repairing its child.`);
            return;
          }
          if (retargeted && "from" in retargeted) {
            // GitHub sends an edited event for the new base; that event wakes the next pass.
            await pullRequestInbox.finish(inboxClaim, { text: `Retargeted from ${retargeted.from} to ${retargeted.to} after the parent pull request merged.` });
            schedulerEvent("babysitter.stack.retargeted", { ...owner, ...retargeted });
            return;
          }
          if (merge.mode === "direct") {
            // A stack child never merges into its parent's branch.
            if (stackParent === undefined && await mergeReadyPullRequest(inboxClaim, owner, passSignal) !== "not-ready") return;
            // A previous pass explicitly reviewed this unchanged head. If the
            // merge gates are still closed, keep waiting instead of invoking
            // the model again. New feedback, conflicts, or a new failure alter
            // the evidence key and invalidate this checkpoint.
            const assessment = await pullRequestInbox.meta(`review-assessment:${repository}#${number}`);
            const held = await heldOpenThreads(inboxClaim.snapshot);
            // A reviewed head whose required checks fail cannot merge. Under `dailyPushBudget`, it waits
            // only while the budget refuses its repair push, and then gets the pass that pushes it.
            let reviewedRetryAt: number | undefined = Date.now() + 120_000;
            let pushWindowRetry = false;
            if (dailyPushBudget !== false && await requiredCheckState(inboxClaim.snapshot) === "failed") {
              const window = await repairPushWindow(inboxClaim.snapshot, "failed", false);
              reviewedRetryAt = window && !window.allowed ? window.nextAt + 60_000 : undefined;
              pushWindowRetry = reviewedRetryAt !== undefined;
            }
            if (reviewedRetryAt !== undefined && isRuntimeRecord(assessment)
              && assessment.version === 2
              && assessment.head === inboxClaim.snapshot.pr?.head?.sha
              && matchesMergeReviewEvidence(assessment.evidenceKey, inboxClaim.snapshot, waitPolicy)
              // A declined P0 or P1 thread waits for a person, not for another pass.
              && inboxClaim.snapshot.threads.every(thread => thread.isResolved === true || held.has(String(thread.node_id ?? thread.id)))
              && inboxClaim.snapshot.pr?.mergeable !== false
              && inboxClaim.snapshot.pr?.mergeable_state !== "dirty") {
              if (stackParent !== undefined) {
                await parkOnStackParent(stackParent, `Waiting for open parent PR #${stackParent} to merge; this child has nothing left to repair.`);
                return;
              }
              // A reviewed draft never merges. Marking it ready sends ready_for_review, which wakes the PR
              // and starts workflows that skip drafts.
              if (inboxClaim.snapshot.pr?.draft === true && await requiredCheckState(inboxClaim.snapshot) !== "failed"
                && await markDraftReady(inboxClaim.snapshot, owner, passSignal)) {
                await pullRequestInbox.finish(inboxClaim, {
                  text: "Marked the reviewed draft ready for review so it can merge.",
                  wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), retryAt: Date.now() + 120_000 },
                });
                return;
              }
              // A direct merge lands only on the default branch, and never merges a draft, so retrying either
              // every two minutes changes nothing. On 2026-10-31 a PR on a branch without a parent PR retried
              // for two days, and on 2026-11-01 a draft reached generation 1929. Retargeting the PR or marking
              // it ready for review wakes it.
              const lockedBase = inboxClaim.snapshot.pr ? nonDefaultBase(inboxClaim.snapshot.pr) : undefined;
              const draft = inboxClaim.snapshot.pr?.draft === true;
              if ((lockedBase || draft) && await requiredCheckState(inboxClaim.snapshot) !== "failed") {
                const reason = lockedBase ? "non-default-base" : "draft";
                await pullRequestInbox.finish(inboxClaim, {
                  text: lockedBase
                    ? `Ready, but its base ${lockedBase.base} is not the default branch and no pull request merges it there. The Babysitter merges only into the default branch: merge this PR by hand or retarget it.`
                    : inboxClaim.snapshot.lastResult || "Reviewed, but the pull request is a draft. It merges once it is marked ready for review.",
                  wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), kind: "external", reason },
                });
                schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, avoided_invocation: true, reason });
                return;
              }
              const retested = await retestMissingRequiredChecks(inboxClaim.snapshot, owner, passSignal);
              // Only a person, new feedback or a new head ends a hold, and each of those wakes the PR.
              const heldText = held.size ? `Waiting for a person to resolve ${held.size === 1 ? "a review thread" : `${held.size} review threads`} the worker declined although the reviewer labeled ${held.size === 1 ? "it" : "them"} P0 or P1.` : undefined;
              await pullRequestInbox.finish(inboxClaim, {
                text: retested ? "A required check never reported on this head; started a fresh CI run." : heldText ?? (inboxClaim.snapshot.lastResult || "Reviewed head is unchanged; waiting for merge gates."),
                wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), retryAt: pushWindowRetry ? reviewedRetryAt : held.size && !retested ? undefined : await mergeRetryAt(inboxClaim.snapshot) },
              });
              schedulerEvent("babysitter.wait.kept", {
                ...owner,
                head_sha: inboxClaim.snapshot.pr?.head?.sha,
                avoided_invocation: true,
                reason: retested ? "missing-required-check-retest" : "reviewed-head-unchanged",
              });
              return;
            }
          }
          if (merge.mode === "direct" && await retestOnCurrentBase(inboxClaim.snapshot, owner, passSignal)) {
            outcome = "waiting";
            await pullRequestInbox.finish(inboxClaim, {
              text: inboxClaim.snapshot.lastResult || `Updated the branch with ${inboxClaim.snapshot.pr?.base?.ref} to retest its failed checks on the current base.`,
              wait: createCheckWait(inboxClaim.snapshot, waitPolicy),
            });
            schedulerEvent("babysitter.wait.kept", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, avoided_invocation: true, reason: "retest-on-current-base" });
            return;
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
          // A conflict the host may resolve alone skips the model gates until its merge is prepared.
          const conflictBlockers = await hostConflictBlockers();
          hostConflictPush = conflictBlockers?.length === 0;
          if (conflictBlockers?.length) schedulerEvent("babysitter.conflict.host_push_skipped", { ...owner, head_sha: inboxClaim.snapshot.pr?.head?.sha, reason: "model-work", blockers: conflictBlockers });
          if (!hostConflictPush && !modelAdmission && inboxClaim.snapshot.recoveryHead !== inboxClaim.snapshot.pr?.head?.sha) {
            // The PR needs a model pass. Leave it queued unchanged until admission reopens.
            await pullRequestInbox.release(inboxClaim);
            const released = await pullRequestInbox.get(repository, number);
            if (released) hostOnlyChecked.set(`${repository}#${number}`, hostOnlyStamp(released));
            outcome = "admission-paused";
            return;
          }
          if (!(await hydrateFailedCiEvidence(pullRequestInbox, inboxClaim, {
            readJson: (path, projection) => readRest(path, projection, passSignal),
            readLog: async (path, repository) => {
              const { provider } = await forge(repository, passSignal);
              return await new Response((await provider.request("GET", `/${path}`, { raw: true, signal: passSignal })).body).text();
            },
          }))) { await pullRequestInbox.release(inboxClaim); return; }
          const ciRecovery = ciRecoveryEnabled ? await rerunFailedActions(
            pullRequestInbox,
            inboxClaim,
            (await forge(repository, passSignal)).provider,
            Date.now(),
            passSignal,
          ) : undefined;
          if (inboxClaim.snapshot.recoveryHead && inboxClaim.snapshot.recoveryHead === inboxClaim.snapshot.pr?.head?.sha && !hasFailedActions(inboxClaim.snapshot)) {
            outcome = "waiting";
            const wait = createCheckWait(inboxClaim.snapshot, waitPolicy);
            if (merge.mode === "direct") wait.retryAt = await mergeRetryAt(inboxClaim.snapshot);
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
          if (ciRecovery?.state === "blocked" && (!ciRecovery.permission || isRuntimeRecord(permissionFallback) && permissionFallback.consumedAt && matchesMergeReviewEvidence(permissionFallback.evidenceKey, inboxClaim.snapshot, waitPolicy))) {
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
            // GitHub sometimes never finishes: on 2026-10-21 15 stack PRs stayed unknown for hours although each
            // merged cleanly. Wait at most 10 minutes per head, then run the pass; a merge re-reads mergeability.
            // Every recheck re-reads the snapshot, so a 30-second recheck on those PRs spent the GitHub App's
            // hourly quota in five minutes.
            const head = inboxClaim.snapshot.pr?.head?.sha;
            const unknownKey = `mergeability-unknown:${repository}#${number}`;
            const saved = await pullRequestInbox.meta(unknownKey);
            const recorded = isRuntimeRecord(saved) && saved.head === head && hasRuntimeType(saved.at, "number") ? saved.at : undefined;
            const since = recorded ?? Date.now();
            if (recorded === undefined) await pullRequestInbox.setMeta(unknownKey, { head, at: since });
            if (Date.now() - since < unknownMergeabilityLimitMs) {
              const reason = "GitHub is still calculating mergeability for this PR head.";
              await pullRequestInbox.finish(inboxClaim, { text: reason,
                wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), kind: "external", reason, retryAt: Date.now() + 120_000 } });
              schedulerEvent("babysitter.mergeability.waiting", { ...owner, head_sha: head });
              return;
            }
            schedulerEvent("babysitter.mergeability.unknown_proceeding", { ...owner, head_sha: head, since });
          }
          if (!hostConflictPush && await parkBlockedModelWork()) return;
          if (ciRecovery?.state === "blocked" && ciRecovery.permission) {
            await pullRequestInbox.setMeta(`ci-permission-fallback:v1:${inboxClaim.snapshot.repository}:${inboxClaim.snapshot.pr?.head?.sha ?? ""}`, { pendingAt: Date.now() });
          }
          const pullRequest = snapshotPullRequest(inboxClaim.snapshot);
          const webhookSnapshot = inboxClaim.snapshot;
          workspaceEntry = await workspaces?.acquire(repository, number, passSignal);
          const workspacePlan = workspaceEntry && workspaceDecision(workspaceEntry.previous, pullRequest.headRefOid, workspaceEntry.existed);
          workspaceRun.head = pullRequest.headRefOid;
          workspaceRun.base = pullRequest.baseRefOid;
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
              // Reads need only the lease: new evidence cannot make a log or feedback read unsafe.
              const readOperation = new AsyncLocalStorage<boolean>();
              const assertLeaseHeld = async () => {
                abortSignal.throwIfAborted();
                const current = await pullRequestInbox.get(repository, number);
                if (current?.lease !== inboxClaim.token || current.leaseUntil <= Date.now()) {
                  throw new DOMException("Pull request lease lost.", "AbortError");
                }
                return current;
              };
              const assertLease = async () => {
                const current = await assertLeaseHeld();
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
                  // Every later write would be refused too, so end the pass and let the claim requeue.
                  const changed = new DOMException("Pull request evidence changed.", "AbortError");
                  schedulerEvent("babysitter.pass.evidence_changed", { ...owner, head_sha: pullRequest.headRefOid, observed_head: observedHead });
                  passController.abort(changed);
                  throw changed;
                }
                return current;
              };
              const conflicting = webhookSnapshot.pr?.mergeable === false || webhookSnapshot.pr?.mergeable_state === "dirty";
              let preparedMergeBase: string | undefined;
              let preparedConflicts: GitHubConflictResolution | undefined;
              const readRepairBase = async () => {
                // PR snapshots can retain an older base after its branch moves.
                // Conflict preparation must merge the current target branch.
                // forges `contents.resolveRef()` resolves tags before branches of the same name.
                const { provider } = await forge(repository, abortSignal);
                const ref = (await provider.request<unknown>("GET", `/repos/${repository}/git/ref/heads/${encodeURIComponent(pullRequest.baseRefName)}`, { signal: abortSignal })).data;
                if (!isRuntimeRecord(ref) || ref.ref !== `refs/heads/${pullRequest.baseRefName}` || !isRuntimeRecord(ref.object)
                  || ref.object.type !== "commit" || !hasRuntimeType(ref.object.sha, "string") || !/^[a-f\d]{40}$/i.test(ref.object.sha)) {
                  throw new Error("Conflict repair requires the exact live base branch commit.");
                }
                return ref.object.sha;
              };
              // A base branch that only moved forward keeps the prepared merge valid. The repair resolves
              // conflicts up to the prepared commit, and GitHub checks the newer commits after the push.
              const baseAdvanced = async (from: string, to: string) => {
                // One page: the status and counts do not need the list of commits between the bases.
                const comparison = await readOnePage(`repos/${repository}/compare/${from}...${to}?per_page=1`, abortSignal);
                return isRuntimeRecord(comparison) && comparison.status === "ahead" && comparison.behind_by === 0;
              };
              const assertRepairBase = async () => {
                if (!preparedMergeBase) return;
                const live = await readPull(repository, number, abortSignal);
                const liveBase = isRuntimeRecord(live) && isRuntimeRecord(live.base) && live.base.ref === pullRequest.baseRefName ? await readRepairBase() : undefined;
                if (!liveBase || liveBase !== preparedMergeBase && !await baseAdvanced(preparedMergeBase, liveBase)) {
                  await pullRequestInbox.hydrate(inboxClaim, { refresh: true });
                  const changed = new DOMException("Pull request base changed; retry the conflict repair against current GitHub state.", "AbortError");
                  passController.abort(changed);
                  throw changed;
                }
              };
              // A kept workspace stays when the previous pass left this head on a clean tree; otherwise it is
              // emptied and checked out again.
              const keptWorkspace = (directory: string) => workspaceRun.prepared && workspaceEntry !== undefined && resolve(directory) === resolve(workspaceEntry.work);
              const prepareKeptWorkspace = async (entry: PullRequestWorkspaceEntry, plan: { reuse: boolean; reason: string }) => {
                // From here the tree may be half reset, so only a finished pass records it as reusable.
                workspaceRun.prepared = true;
                const preparedAt = Date.now();
                const result = await prepared.prepareWorkspace(entry.work, { reuse: plan.reuse, reason: plan.reason });
                workspaceRun.reason = result?.reason ?? plan.reason;
                workspaceRun.durationMs = Date.now() - preparedAt;
                schedulerEvent("babysitter.workspace.prepared", { ...owner, head_sha: pullRequest.headRefOid, workspace: result?.reused ? "warm" : "reset", reason: workspaceRun.reason, durationMs: workspaceRun.durationMs });
              };
              const prepareRepairWorkspace = async (directory: string, nodeOptions?: string) => {
                // The provider may report the prepared workspace by another spelling of its path.
                if (!preparedDirectories.has(resolve(directory))) {
                  if (directory !== checkout && !keptWorkspace(directory)) await prepared.prepareWorkspace(directory, resolve(directory) === conflictWork ? { complete: true } : { restoreInstructions: true });
                  if (conflicting) {
                    const base = await readRepairBase();
                    preparedConflicts = await prepareGitHubRepairBase(directory, {
                      expectedHead: pullRequest.headRefOid, base, signal: abortSignal, fetch: { url: `https://github.com/${repository}.git`, env: prepared.env },
                      conflicts: hostInstall() ? { slots: installSlots } : { regenerateLockfile: false },
                    });
                    preparedMergeBase = base;
                    if (preparedConflicts) {
                      const { conflicted, resolved, remaining, lockfile } = preparedConflicts;
                      schedulerEvent("babysitter.conflict.prepared", {
                        ...owner, head_sha: pullRequest.headRefOid, base_sha: base,
                        conflicted: conflicted.length, resolved: resolved.length, remaining: remaining.length,
                        conflicted_files: conflicted.slice(0, 20), resolved_files: resolved.slice(0, 20).map(({ path, rule }) => `${path} (${rule})`), remaining_files: remaining.slice(0, 20),
                        ...(lockfile ? { lockfile: lockfile.slice(0, 200) } : {}),
                      });
                    }
                  }
                  // A kept tree whose install record matches its current inputs needs no install.
                  const installed = hostInstall() && keptWorkspace(directory) && workspaceRun.reason === "warm" && !preparedMergeBase
                    && !(isRuntimeRecord(installOption) && installOption.command) && await hasCurrentGitHubDependencies(directory);
                  if (installed) schedulerEvent("babysitter.install.skipped", { ...owner, reason: "warm-workspace" });
                  else if (hostInstall()) {
                    try { await installDependencies(directory, abortSignal, owner, nodeOptions); }
                    catch (error) {
                      if (abortSignal.aborted || !(error instanceof GitHubWorkspaceInstallError)) throw error;
                      // Dependency conflicts must be resolved before the explicit refresh tool can install.
                      const conflict = error.cause instanceof GitHubDependencyConflictError;
                      if (conflict && !preparedMergeBase) throw error;
                      // Busy installer slots are a host wait, not a failed install. The PR waits
                      // for capacity instead of spending a pass without dependencies.
                      if (error.kind === "capacity") throw error;
                      // An optional install, or a lockfile defect handed to this pass, continues without
                      // dependencies. The failure stays in .git/vitehub-install.json for the model.
                      // A lockfile the host regenerated for this merge goes to the model like the conflict it replaced.
                      const regenerated = preparedConflicts?.resolved.some(({ rule }) => rule === "pnpm-lockfile") === true;
                      if (!conflict && installRequired && !((installDefect || regenerated) && isGitHubLockfileDefect(error))) throw error;
                      if (!conflict) schedulerEvent("babysitter.install.continued", { ...owner, reason: installFailure(error).replace(/\n/g, " ").slice(0, 300) });
                    }
                  }
                  preparedDirectories.add(resolve(directory));
                }
              };
              // Operations ask for a provider before each request group, so every group checks the lease.
              const operationHost: Pick<GitHubHost, "forge"> = {
                forge: async (input) => {
                  await (readOperation.getStore() ? assertLeaseHeld() : assertLease());
                  return await github.forge(input);
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
                autoMerge: merge.mode === "auto" && stackParent === undefined,
                eligible: (current) =>
                  pullRequestInbox.eligible(repository, normalizePullRequest(current)),
                checkDependencies: async () => {
                  await assertLease();
                  if (presetOptions.install === false) return { current: true, changedInputs: [], reason: "Host dependency installation is disabled." };
                  if (!hostInstall()) return { current: true, changedInputs: [], reason: "The Sandbox installs dependencies. Call refreshDependencies after you change dependency inputs." };
                  return await readGitHubDependencyStatus(providerDirectory ?? checkout);
                },
                refreshDependencies: async () => {
                  if (!providerDirectory) throw new Error("The repair workspace is not prepared.");
                  await assertLease();
                  await assertRepairBase();
                  const customInstaller = isRuntimeRecord(installOption) && Boolean(installOption.command);
                  let refreshed = false;
                  if (hostInstall() && (customInstaller || !await hasCurrentGitHubDependencies(providerDirectory))) {
                    await installDependencies(providerDirectory, abortSignal, owner, undefined);
                    refreshed = true;
                  }
                  // A successful refresh rebuilt the dependency graph, so the
                  // recovery pass can verify it before committing repaired inputs.
                  if (refreshed) installDefect = undefined;
                  await assertLease();
                },
                commitRepair: async (input) => {
                  if (!providerDirectory) throw new Error("The repair workspace is not prepared.");
                  await assertLease();
                  await assertRepairBase();
                  // After a failed optional install there is nothing to verify against; hosted CI validates the dependency inputs.
                  // A handed-off lockfile defect is the recovery pass that repairs the
                  // dependency inputs, so the previously failed graph cannot be verified yet.
                  // With the refresh limit spent, the model cannot reinstall changed inputs, so hosted CI validates them.
                  const verifyDependencies = hostInstall() && !installDefect && (installRequired || !await installFailed(providerDirectory))
                    && (refreshLimit === undefined || dependencyRefreshes < refreshLimit || await hasCurrentGitHubDependencies(providerDirectory));
                  if (verifyDependencies) await assertGitHubDependenciesCurrent(providerDirectory);
                  const head = await prepared.commitRepair(providerDirectory, input, { verifyDependencies });
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
                        const window = await repairPushWindow(current, await requiredCheckState(current), current.pr?.mergeable === false);
                        if (window && !window.allowed) throw presetsErrorDiagnostics.PRESETS_DAILY_PUSH_BUDGET_SPENT({ count: window.count, nextAt: new Date(window.nextAt).toISOString() });
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
                      afterPush: async head => {
                        if (dailyPushBudget !== false && head !== pullRequest.headRefOid) {
                          await pullRequestInbox.setMeta(`repair-pushes:${repository}#${number}`, [...await repairPushTimes(inboxClaim.snapshot), Date.now()]);
                        }
                        recordPush(head);
                        await assertLease();
                      },
                    });
                    recordPush(result);
                    return result;
                  } finally {
                    observePendingPush = undefined;
                    clearInterval(renew);
                  }
                },
              });
              const { readCheckLogs, readBaseCheckEvidence, readBaseCheckLogs } = operations;
              operations.readCheckLogs = runId => readOperation.run(true, () => readCheckLogs(runId));
              operations.readBaseCheckEvidence = () => readOperation.run(true, () => readBaseCheckEvidence());
              operations.readBaseCheckLogs = runId => readOperation.run(true, () => readBaseCheckLogs(runId));
              const resolveThread = operations.resolveThread;
              operations.resolveThread = (id, answer) => repairOperation.run(true, async () => {
                const current = await assertLease();
                const reopens = current.threadReopens?.[id] ?? 0;
                const resolution = await resolveThread(id, answer);
                if (resolution.held) {
                  const held = await pullRequestInbox.meta(heldThreadsKey(repository, number));
                  await pullRequestInbox.setMeta(heldThreadsKey(repository, number), [...new Set([...Array.isArray(held) ? held.filter(item => hasRuntimeType(item, "string")) : [], id])].slice(-100));
                  return resolution;
                }
                await pullRequestInbox.recordThreadResolution(inboxClaim, id, current);
                // Record only a successful, PR-owned resolution. New comments
                // remain in the evidence hash; any external reopen revokes it.
                ownedResolutions.set(id, reopens);
                return resolution;
              });
              const baseSettings = agentSettings(baseAgent);
              const driver = baseSettings?.driver;
              if (
                !driver ||
                typeof driver !== "object" ||
                !("kind" in driver) ||
                (driver.kind !== "codex" && driver.kind !== "claude-code")
              ) {
                throw new Error(
                  "Babysitter requires a Codex or Claude Code driver for its isolated Git checkout.",
                );
              }
              const workerDriver = driver as
                | CodexDriver<unknown, BabysitterPassResult>
                | ClaudeCodeDriver<unknown, BabysitterPassResult>;
              const activityEnabled = statusComment;
              const workerName = `${options.agentName ?? baseAgent.name ?? "babysitter"}-worker`;
              if (!baseSettings) throw new Error("Babysitter base Agent settings are unavailable.");
              // Build the worker from the base settings while replacing only
              // its GitHub Channel. Extending the base Agent would preserve
              // the host forge access, but dropping the whole map loses other
              // channel-scoped capabilities needed by repair passes.
              const { channels: _baseChannels, workspace: configuredWorkspace, ...workerSettings } = baseSettings;
              // Placement runs once per pass, before any host install, and never overrides a configured Sandbox.
              // A lockfile repair runs on this host: a placed Sandbox installs dependencies before the model starts.
              // So does a conflict the host may resolve alone, which needs the host install to verify its merge.
              if (presetOptions.placement && !workerSettings.sandbox && !installDefect && !hostConflictPush) {
                placementLease ??= await presetOptions.placement.place({ repository, number });
                if (placementLease.sandbox) workerSettings.sandbox = placementLease.sandbox;
              }
              if (workerSettings.sandbox) providerDirectory = checkout;
              else if (workspaceEntry && workspacePlan) await prepareKeptWorkspace(workspaceEntry, workspacePlan);
              const keptWork = workspaceEntry && !workerSettings.sandbox ? workspaceEntry.work : undefined;
              // Without a kept workspace, a conflicting PR gets a provider workspace that the host owns, so the
              // host merges and installs before the model starts and the model continues in the same tree.
              if (conflicting && !workerSettings.sandbox && !keptWork) conflictWork = await mkdtemp(join(tmpdir(), `vitehub-${repository.replace("/", "-")}-merge-pr-${number}-`));
              const providerWork = keptWork ?? conflictWork;
              const baseChannels = isRuntimeRecord(_baseChannels) ? _baseChannels : {};
              const workerBaseChannels = Object.fromEntries(Object.entries(baseChannels).map(([name, channel]) => {
                // A GitHub channel under any key can otherwise reintroduce host credentials.
                if (!isRuntimeRecord(channel) || channel.kind !== "github") return [name, channel];
                return [name, withoutForgeAccess(channel)];
              }));
              const baseCapabilities = workerSettings.capabilities;
              const repair = repairCapability(operations, merge.mode === "auto", presetOptions.mentionAllowlist, async (context) => {
                if (!workerSettings.sandbox) return;
                const session = activeProviderSandbox(context);
                if (!session) throw new Error("The repair Sandbox is not prepared.");
                await assertLease();
                if (!session.localWorkspace) await importSandboxCommit(session.session, checkout, pullRequest.headRefOid, abortSignal);
              }, {
                runRepair: execute => repairOperation.run(true, execute),
                admitRefresh: () => {
                  if (refreshLimit !== undefined && dependencyRefreshes >= refreshLimit) throw presetsErrorDiagnostics.PRESETS_DEPENDENCY_REFRESH_LIMIT({ limit: refreshLimit });
                  dependencyRefreshes++;
                  return () => { dependencyRefreshes--; };
                },
                readFeedback: async input => readBabysitterFeedback(await assertLeaseHeld(), input),
                readState: async () => {
                  let current = await assertLease();
                  const directory = providerDirectory ?? checkout;
                  const record = await readFile(join(directory, ".git", "vitehub-install.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
                  const dependencies: unknown = record === undefined ? undefined : JSON.parse(record);
                  current = await assertLease();
                  return {
                    repository, number, assignedHead: pullRequest.headRefOid, observedHead: current.pr?.head?.sha,
                    assignedBase: pullRequest.baseRefOid, publishedHead: pushedHead,
                    claim: { current: true, generation: current.generation, revision: current.revision ?? 0 },
                    dependencies: isRuntimeRecord(dependencies) ? { status: dependencies.status ?? (dependencies.ok ? "installed" : "failed"), fingerprint: dependencies.fingerprint, command: dependencies.command, reason: dependencies.reason } : { status: installOption === false ? "disabled" : "not-recorded" },
                  };
                },
                beforeRepair: async (context, paths) => {
                  if (!workerSettings.sandbox) return;
                  await assertLease();
                  await assertRepairBase();
                  const sandbox = activeProviderSandbox(context);
                  if (!sandbox) throw new Error("The repair Sandbox is not prepared.");
                  if (!sandbox.localWorkspace) {
                    await importSandboxCommit(sandbox.session, checkout, pullRequest.headRefOid, abortSignal);
                    if (paths) await importSandboxRepairFiles(sandbox.session, checkout, paths, abortSignal);
                    else await importSandboxRepairWorkspace(sandbox.session, checkout, abortSignal);
                  }
                  await assertLease();
                },
                afterRefresh: async context => {
                  if (!workerSettings.sandbox || presetOptions.install === false) return;
                  await assertLease();
                  const sandbox = activeProviderSandbox(context);
                  if (!sandbox) throw new Error("The repair Sandbox is not prepared.");
                  if (!sandbox.localWorkspace) await publishSandboxDependencies(sandbox.session, checkout, abortSignal);
                  await assertLease();
                },
              });
              const workerCapabilities = typeof baseCapabilities === "function"
                ? async (context: Parameters<AgentCapabilitiesResolver>[0]) => [
                  ...(await baseCapabilities(context)).filter(capability => capability.id !== "babysitter.github"),
                  repair,
                ]
                : [
                  ...(Array.isArray(baseCapabilities) ? baseCapabilities : []).filter(capability => capability.id !== "babysitter.github"),
                  repair,
                ];
              // Preserve host-owned activity and delivery closures without
              // exposing their forge access to provider credential resolution.
              const workerChannel = withoutForgeAccess(github.channel({
                activity: activityEnabled,
                // The Channel filter would require both author rules and compare logins exactly.
                pullRequest: { filter: { ...filter, author: undefined, authorAssociation: undefined, actor: undefined }, when: context => matchesBabysitterPullRequestFilter(context, filter), workspace: false },
              }));
              // Keep the base Agent's configured Workspace sources, loaders, and
              // instruction bindings while replacing the checkout-owned fields.
              let baseWorkspace: Record<string, unknown> = {};
              if (hasRuntimeType(configuredWorkspace, "string")) {
                baseWorkspace = { ...await resolveRegisteredWorkspaceDefinition(configuredWorkspace) };
              }
              else if (isRuntimeRecord(configuredWorkspace)) {
                const workspaceName = Object.hasOwn(configuredWorkspace, "name") && hasRuntimeType(configuredWorkspace.name, "string")
                  ? configuredWorkspace.name
                  : undefined;
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
                  output: { ...workerDriver.output, schema: passResultSchema },
                  // Match the preset: unattended passes cannot escalate native
                  // permissions. Repair tools remain authorized by the host.
                  permissions: "allow-edits-unattended" as const,
                  // The provider works in the kept or host-owned workspace, so it neither creates nor removes a temporary root.
                  ...(providerWork ? { cwd: providerWork } : {}),
                  env: async (context: AgentProviderCredentialContext) => {
                    const environment =
                      workerDriver.env === undefined
                        ? undefined
                        : await resolveRuntimeValue(workerDriver.env, context);
                    // The host owns installs. pnpm must not reinstall before each script because the
                    // host install used settings, such as disabled hooks, that the checkout does not declare.
                    return repairEnvironment({ ...(presetOptions.install === false ? {} : { npm_config_verify_deps_before_run: "false" }), ...environment }, join(checkout, ".vitehub-github-auth"), prepared.env);
                  },
                  ...(workerSettings.sandbox ? undefined : { launch: async (context: AgentProviderLaunchContext) => {
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
                    await assertLease();
                    return launch;
                  } }),
                },
              };
              /**
               * Commits and pushes a prepared merge whose every conflict the host resolved, with no model pass. The
               * commit verifies the frozen dependencies, and the push passes the lease, base and push-window fences
               * of a model's pushRepair. A refusal before the push leaves the prepared merge to the model.
               */
              const pushHostResolvedMerge = async (directory: string): Promise<boolean> => {
                if (!preparedConflicts) return false;
                const { resolved, remaining } = preparedConflicts;
                const refuse = async (reason: string) => {
                  await pullRequestInbox.setMeta(hostConflictKey, { head: pullRequest.headRefOid, base: webhookSnapshot.pr?.base?.sha });
                  schedulerEvent("babysitter.conflict.host_push_skipped", { ...owner, head_sha: pullRequest.headRefOid, reason });
                  return false;
                };
                if (remaining.length) return await refuse("conflicts-remain");
                // Only a current frozen install lets commitRepair verify the merged dependency graph.
                if (!hostInstall() || installDefect || await installFailed(directory) || !await hasCurrentGitHubDependencies(directory)) return await refuse("dependencies-unverified");
                const paths = resolved.map(({ path }) => path);
                try {
                  await repairOperation.run(true, () => operations.commitRepair({ message: `Merge ${pullRequest.baseRefName} into ${pullRequest.headRefName}`, paths }));
                } catch (error) {
                  if (isAbortError(error)) throw error;
                  return await refuse(`commit: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200)}`);
                }
                const head = await repairOperation.run(true, () => operations.push());
                schedulerEvent("babysitter.conflict.host_pushed", {
                  ...owner, head_sha: pullRequest.headRefOid, pushed_head: head, base_sha: preparedMergeBase,
                  resolved_files: resolved.slice(0, 20).map(({ path, rule }) => `${path} (${rule})`),
                });
                resultText = `Merged ${pullRequest.baseRefName} and resolved the conflicts in ${paths.join(", ")} on the host, without a model pass. Waiting for checks on ${head}.`;
                return true;
              };
              // A conflicting PR's merge is prepared before a model slot or a daily pass is taken, so a merge the host
              // resolved completely needs no pass and the prompt names the files it resolved. Sandbox runtimes copy
              // the host cwd when they open, so they always get the exact merge and installed graph first.
              const preparedWork = workerSettings.sandbox ? checkout : conflicting ? providerWork : undefined;
              if (preparedWork) {
                await prepareRepairWorkspace(preparedWork);
                providerDirectory = preparedWork;
                if (hostConflictPush && await pushHostResolvedMerge(preparedWork)) return;
                if (await parkBlockedModelWork()) throw new DOMException("Provider dispatch is waiting for admission.", "AbortError");
              }
              const agent = workerSettings.sandbox
                ? defineAgent({ ...workerOptions, sandbox: { ...workerSettings.sandbox, checkout: undefined, cwd: checkout, requires: [...(workerSettings.sandbox.requires ?? []), "git"] } })
                : defineAgent({ ...workerOptions, workspace: {
                    ...baseWorkspace,
                    commit: false,
                    mode: "write",
                    store: { provider: "local", root: providerWork ?? checkout, locks: "process" },
                  } });
              const repairCandidate = mainRepair && mainRepairPrefix && mainRepairWatches(repository)
                && pullRequest.headRepository?.nameWithOwner.toLowerCase() === repository.toLowerCase()
                && pullRequest.headRefName.startsWith(mainRepairPrefix);
              const repairRepository = repairCandidate ? await readOnePage(`repos/${repository}`, abortSignal) : undefined;
              const mainRepairContext = mainRepairWorkerContext({
                enabled: Boolean(repairCandidate), repository, sourceRepository: pullRequest.headRepository?.nameWithOwner,
                branch: pullRequest.headRefName, prefix: mainRepairPrefix, base: pullRequest.baseRefName,
                defaultBranch: isRuntimeRecord(repairRepository) ? repairRepository.default_branch : undefined,
              });
              const prompt = `Repair PR #${number} in ${repository}. Expected HEAD ${pullRequest.headRefOid}, source branch ${pullRequest.headRefName}, source repository ${pullRequest.headRepository?.nameWithOwner ?? "unavailable"}. ${pullRequest.url}`;
              const snapshotContext = snapshotPrompt(webhookSnapshot);
              const installContext = installDefect ? `\n\n<dependency-install-failure>\nThe host's frozen dependency install rejected this head, so the checkout has no dependencies installed:\n${installDefect}\nRepair the lockfile or the manifest that the error names until the frozen install passes. For pnpm, resolve with \`pnpm install --lockfile-only\` or \`pnpm install --lockfile-only --fix-lockfile\` if needed, then finish with a plain \`pnpm install --ignore-scripts\`: \`--lockfile-only\` does not download URL tarballs, so a dependency such as a pkg.pr.new build keeps no integrity and the frozen install fails with ERR_PNPM_MISSING_TARBALL_INTEGRITY. Then call refreshDependencies, validate, include the lockfile in commitRepair and call pushRepair.\n</dependency-install-failure>` : "";
              const requiredChecksNow = dailyPushBudget === false ? undefined : await requiredCheckState(inboxClaim.snapshot);
              const pushWindow = requiredChecksNow && await repairPushWindow(inboxClaim.snapshot, requiredChecksNow, inboxClaim.snapshot.pr?.mergeable === false || inboxClaim.snapshot.pr?.mergeable_state === "dirty");
              // Say up front whether this pass can push, so a pass that the push gate refuses builds no commit.
              const pushContext = !pushWindow ? ""
                : !pushWindow.allowed ? `\n\n<push-window>\nThis PR already has ${pushWindow.count} repair pushes in the last 24 hours, so pushRepair refuses every push until ${new Date(pushWindow.nextAt).toISOString()}. Do not edit files or commit. Assess the current HEAD: reply to and resolve the automated findings, classify each one, and set reviewedHead to the current HEAD.\n</push-window>`
                  : pushWindow.spaced ? `\n\n<push-window>\nThis PR already has ${pushWindow.count} repair pushes in the last 24 hours. Its required checks fail, so this pass may push one commit, and the next push opens two hours later. Make that commit fix the failing required checks (setup, lockfile, lint, typecheck, build or tests) first. Leave review findings below P0 for a later pass.\n</push-window>`
                    : requiredChecksNow === "failed" ? `\n\n<required-checks-failing>\nRequired checks fail on this head. Fix them before review findings, and push the fix in this pass even when review findings remain: the PR cannot merge until they pass.\n</required-checks-failing>` : "";
              if (workspaceEntry && keptWork && workspaces?.resumeThreads) {
                workspaceRun.session = providerSessionDecision(workspaceEntry.previous, workspaceRun.reason, { base: pullRequest.baseRefOid, release });
              }
              const resumeContext = workspaceRun.session?.resume ? `\n\n<resumed-pass>\nThis pass continues your previous session on this PR. The checkout is the one your last pass left at HEAD ${pullRequest.headRefOid}, with its dependencies installed. The snapshot below is the current state; where it differs from what you saw before, it wins. Assess its new comments, reviews and checks before you act.\n</resumed-pass>` : "";
              const settled = reviewPushBudgetSpent(inboxClaim.snapshot, waitPolicy);
              const reviewPushes = inboxClaim.snapshot.reviewPushBudget?.count ?? 0;
              const severityContext = minorReviewRounds !== false && !settled ? `\n\n<automated-review-severity>\nSet automatedReview in the JSON result to the highest class of valid finding in the automated reviews of HEAD ${pullRequest.headRefOid}: "P0" (security hole, data loss or a broken main path), "P1" (a real bug on a supported path or a broken documented contract), "P2" (an edge case, a missing test or a docs gap), "P3" (style or a nit), or "none" when they have no valid finding. A fixed or false finding has no class. Omit it when no automated review of that head exists yet. After ${minorReviewRounds} heads in a row with nothing above P2, bot feedback and review checks no longer start passes.\n</automated-review-severity>` : "";
              const convergenceContext = reviewConvergencePushes !== false && !settled && reviewPushes >= reviewConvergencePushes ? `\n\n<review-convergence>\nThis PR already has ${reviewPushes} review-driven repair pushes. Before you fix a finding, check whether it is another case of a class that an earlier push or thread already addressed. If it is, do not patch the new case: change the approach so that the whole class cannot occur (for example, narrow the contract or report an unknown value as unknown), in this one push, and say so in the thread replies. If no such change fits this PR's scope, decline the remaining P2 cases of that class with outcome declined.\n</review-convergence>` : "";
              const conflictContext = preparedConflicts?.resolved.length ? `\n\n<host-resolved-conflicts>\nThe host resolved and staged these merge conflicts mechanically. Review them instead of redoing them:\n${preparedConflicts.resolved.slice(0, 50).map(({ path, rule }) => `- ${path} (${rule})`).join("\n")}\n${preparedConflicts.remaining.length ? `Still conflicted: ${preparedConflicts.remaining.slice(0, 50).join(", ")}.` : "No conflicted file remains; review the merge, validate it and pass these paths to commitRepair."}\n</host-resolved-conflicts>` : "";
              const userMessage = `${prompt}${mainRepairContext}${resumeContext}\n\n${snapshotContext}${installContext}${conflictContext}${pushContext}${severityContext}${convergenceContext}`;
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
              // resumes a Codex process whose temporary cwd was deleted. A
              // resumed pass reuses the session of the pass that left its workspace.
              workspaceRun.thread = workspaceRun.session?.resume ? workspaceEntry?.previous?.session : runId;
              githubRun.threadId = `${githubRun.threadId}:${workspaceRun.thread}`;
              inboxClaim.activity = githubRun.activity;
              // The daily pass this claim recorded, given back when the provider fails the pass early.
              let recordedPass: { at: number; exemption?: string } | undefined;
              const result = await runWithProviderRetry(async () => {
                // Run metadata and retry backoff can outlive a sibling admission
                // block. Check each Sandbox dispatch immediately before runAgent.
                if (workerSettings.sandbox && await parkBlockedModelWork()) throw new DOMException("Provider dispatch is waiting for admission.", "AbortError");
                await acquireModelSlot(abortSignal, `${repository}#${number}`);
                try {
                  // Each pass that starts the model counts once against the daily pass budget.
                  if (!modelDispatched && dailyPassBudget !== false) {
                    const exemption = dailyPassExemptionUsed === humanFeedbackExemption ? undefined : dailyPassExemptionUsed;
                    const recorded = await pullRequestInbox.recordModelPass(inboxClaim, exemption);
                    if (!recorded || !await pullRequestInbox.isClaimCurrent(inboxClaim)) throw new DOMException("Provider dispatch lost its inbox lease.", "AbortError");
                    recordedPass = { at: recorded, exemption };
                  }
                  // Keep the ownership fence immediately before entering the
                  // provider runtime; setup and admission may have taken time.
                  await assertLease();
                  modelDispatched = true;
                  const [error, result] = await runAgent(
                    agent,
                    {
                      abortSignal,
                      context,
                      messages: [createMessage({ role: "user", text: userMessage })],
                    },
                    {
                      // The pass does not keep background work alive after it returns.
                      runtimeContext: { runtime: "vite", run: githubRun, waitUntil: () => {} },
                      schedule: { ...schedule, runId },
                    },
                  );
                  // Provider retry and abort handling read the original failure.
                  if (error) throw error.cause ?? error;
                  return result.output;
                } finally {
                  releaseModelSlot();
                }
              }, abortSignal, () => { providerLimited = true; }).catch(async (error: unknown) => {
                if (recordedPass && isProviderFailure(error) && Date.now() - recordedPass.at < providerFailureReleaseMs
                  && await pullRequestInbox.releaseModelPass(inboxClaim, recordedPass.at, recordedPass.exemption)) {
                  schedulerEvent("babysitter.daily_pass_budget.released", { ...owner, head_sha: pullRequest.headRefOid, ...recordedPass.exemption ? { exemption: recordedPass.exemption } : {},
                    reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) });
                }
                throw error;
              });
              // The structured worker driver validates its output with
              // passResultSchema before runAgent returns. Revalidating here
              // would invoke the diagnostic reporter a second time.
              // SAFETY: The configured worker output schema guarantees this
              // shape before runAgent resolves.
              passResult = result as BabysitterPassResult;
              if (passResult.automatedReview) inboxClaim.automatedReview = passResult.automatedReview;
              if (passResult?.reviewedHead && passResult.reviewedHead !== pullRequest.headRefOid) schedulerEvent("babysitter.result.stale_assessment", { ...owner, reviewed_head: passResult.reviewedHead, head_sha: pullRequest.headRefOid });
              disposition = passResult.disposition;
              resultText = passResult.text;
            },
            { signal: passSignal, timeout: 60 * 60 * 1000, ...(workspaceEntry ? { persistent: { checkout: workspaceEntry.checkout, work: workspaceEntry.work } } : {}) },
          );
          workspaceRun.ok = true;

          if (modelWorkParked) return;

          const current = await pullRequestInbox.get(repository, number);
          // Checks and bot reviews often arrive during a pass and move the claim revision. A review of the
          // unchanged head stays valid: its evidence key comes from the claim, so newer evidence still needs a pass.
          // With direct merges, a reviewed head stays assessed when the pass parks on an external reason such as
          // a failing approval check: on 2026-10-19 one PR reported no P0 or P1 three times and never merged.
          // Required checks, conflicts and the merge gate still decide the merge.
          const assessed = (passResult?.wait?.kind !== "external" || merge.mode === "direct") && !pushedHead && disposition === "park" && passResult?.reviewedHead === pullRequest.headRefOid
            && current?.pr?.head?.sha === pullRequest.headRefOid && await pullRequestInbox.holdsClaimedHead(inboxClaim);
          if (assessed) await recordAssessment(inboxClaim.snapshot, { head: pullRequest.headRefOid, evidenceKey: mergeReviewEvidenceKey(inboxClaim.snapshot, waitPolicy) });
          // A push alone proves nothing, but a pass that reports its own pushed head as reviewed inspected the
          // feedback it was given. Record that feedback only, never the head's check evidence, so the next
          // claim does not spend another pass reading the same comments.
          else if (pushedHead && passResult?.reviewedHead === pushedHead && passResult.wait?.kind !== "external") await recordAssessment(inboxClaim.snapshot);
          let recorded = false;
          const terminal = current?.status === "terminal";
          if (terminal) {
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, terminal: true });
          } else if (pushedHead) {
            outcome = "waiting";
            recorded = await parkOnPushedHead(inboxClaim, resultText, pushedHead, [...verifiedPushHeads], passResult?.wait, reviewDrivenPush());
          } else if (!assessed && disposition === "park" && current?.pr?.head?.sha === pullRequest.headRefOid && passResult?.wait?.kind === "external") {
            outcome = "waiting";
            await pullRequestInbox.setMeta(`review-assessment:${repository}#${number}`, null);
            // A blocker named without a push is not progress. New bot feedback can wake
            // the same head again, so the budget bounds these passes.
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, progress: { kind: "no-progress" },
              wait: await externalWait(inboxClaim.snapshot, passResult.wait.wake, passResult.wait.reason) });
          } else if (disposition === "park" && current?.pr?.head?.sha === pullRequest.headRefOid && (passResult?.wait?.kind === "checks" && passResult.wait.headSha === pullRequest.headRefOid
            || passResult?.waitForChecksHead === pullRequest.headRefOid || hasPendingChecks(inboxClaim.snapshot, waitPolicy))) {
            // A reproduced external gate waits on this head until its evidence changes.
            outcome = "waiting";
            // Preserve the declared head across check progress. Wait evaluation
            // still wakes new failures or feedback from the observed snapshot.
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, progress: { kind: "no-progress" },
              wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), headSha: pullRequest.headRefOid, ...(assessed && merge.mode === "direct" ? { retryAt: await mergeRetryAt(inboxClaim.snapshot) } : undefined) } });
          } else if (assessed) {
            outcome = "waiting";
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, progress: { kind: "no-progress" }, wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), headSha: pullRequest.headRefOid, ...(assessed && merge.mode === "direct" ? { retryAt: await mergeRetryAt(inboxClaim.snapshot) } : {}) } });
          } else {
            if (disposition === "park") schedulerEvent("babysitter.result.unqualified_park", { ...owner, head_sha: pullRequest.headRefOid });
            // A park that names no external gate still consumed a pass without progress.
            outcome = "retry";
            recorded = await pullRequestInbox.finish(inboxClaim, { text: resultText, retry: true, progress: { kind: "no-progress" } });
          }
          if (recorded && ciRecovery?.state === "blocked" && ciRecovery.permission) {
            await pullRequestInbox.setMeta(`ci-permission-fallback:v1:${inboxClaim.snapshot.repository}:${inboxClaim.snapshot.pr?.head?.sha ?? ""}`, { consumedAt: Date.now(), evidenceKey: fallbackEvidenceKey });
          }
        } catch (error) {
          // A pass that pushed ends on the post-push grace abort; its workspace holds the pushed head.
          if (pushedHead && (isAbortError(error) || (error instanceof Error && error.name === "TimeoutError"))) workspaceRun.ok = true;
          if (modelWorkParked) return;
          if (error instanceof GitHubWorkspaceInstallError) {
            outcome = "waiting";
            const wait = createCheckWait(inboxClaim.snapshot, waitPolicy);
            wait.kind = "external";
            wait.reason = error.message;
            wait.reasonCode = `install-${error.kind}`;
            if (error.retryable) wait.retryAt = Date.now() + 300_000;
            else if (isGitHubLockfileDefect(error)) await handInstallDefect(error, wait);
            await pullRequestInbox.finish(inboxClaim, { text: error.message, wait });
            if (error.kind === "capacity") schedulerEvent("babysitter.install.waiting", { ...owner, reason: "install-capacity", retryAt: wait.retryAt });
            else schedulerError("babysitter.install.failed", error, { ...owner, reason: wait.reasonCode });
            return;
          }
          if (!pushedHead && isBabysitterPlacementCapacityError(error)) {
            outcome = "waiting";
            const wait = createCheckWait(inboxClaim.snapshot, waitPolicy);
            wait.kind = "external";
            wait.reason = error.message;
            wait.reasonCode = "placement-capacity";
            wait.retryAt = Date.now() + (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 30_000);
            await pullRequestInbox.finish(inboxClaim, { text: error.message, wait });
            schedulerEvent("babysitter.placement.waiting", { ...owner, reason: "placement-capacity", retryAt: wait.retryAt });
            return;
          }
          if (pushedHead && (await pullRequestInbox.get(repository, number))?.status !== "terminal") {
            // The repair reached GitHub. Its checks and reviews resume the PR.
            outcome = "waiting";
            await parkOnPushedHead(inboxClaim, error instanceof Error ? error.message : String(error), pushedHead, [...verifiedPushHeads], passResult?.wait, reviewDrivenPush());
            await noteForgeQuota(error, "owner-pushed");
            const expected = isAbortError(error) || (error instanceof Error && error.name === "TimeoutError") || error instanceof RateLimitedError;
            if (!expected) schedulerError("babysitter.owner.failed", error, owner);
          } else if (isAbortError(error)) {
            outcome = "completed";
            await pullRequestInbox.finish(inboxClaim, {
              text: pushSucceeded
                ? "Repair pushed; waiting for new webhook evidence."
                : "Pass interrupted; current webhook state retained.",
              retry: !pushSucceeded,
              terminal: (await pullRequestInbox.get(repository, number))?.status === "terminal",
              // A cancelled model pass used its turn. A provider rate limit did not.
              ...modelDispatched && !pushSucceeded && !providerLimited ? { progress: { kind: "no-progress" as const } } : {},
            });
            schedulerEvent("babysitter.owner.cancelled", {
              reason: "pull-request-state-changed-or-aborted",
              ...owner,
            });
          } else if (error instanceof RateLimitedError) {
            outcome = "deferred";
            await noteForgeQuota(error, "owner");
            await pullRequestInbox.finish(inboxClaim, {
              text: pushSucceeded
                ? "Repair pushed; waiting for new webhook evidence."
                : "GitHub rate limit; retrying after it resets.",
              retry: !pushSucceeded,
            });
            schedulerEvent("babysitter.owner.deferred", { reason: "github-rate-limit", ...owner });
          } else if (!pushSucceeded && isTransientNetworkError(error)) {
            // A dropped connection to GitHub or the provider says nothing about the PR, so it is no failed pass.
            outcome = "deferred";
            await pullRequestInbox.finish(inboxClaim, { text: "Network error; retrying the pass.", retry: true });
            schedulerEvent("babysitter.owner.deferred", { reason: "network", detail: (error instanceof Error ? error.message : String(error)).slice(0, 200), ...owner });
          } else if (!pushSucceeded && isProviderRateLimit(error) && await parkBlockedModelWork()) {
            // The retries already opened the provider cooldown. A model 429 is the shared quota, not
            // this PR, so park until the cooldown ends instead of recording a failure.
            schedulerEvent("babysitter.owner.deferred", { reason: "provider-rate-limit", ...owner });
          } else {
            outcome = "failed";
            if (/head.*(?:mismatch|changed)|expected.*head/i.test(String(error))) {
              await pullRequestInbox.hydrate(inboxClaim, { refresh: true });
            }
            await pullRequestInbox.finish(inboxClaim, {
              text: error instanceof Error ? error.message : String(error),
              retry: !pushSucceeded,
              ...!pushSucceeded ? { progress: { kind: "no-progress" as const } } : {},
            });
            schedulerError("babysitter.owner.failed", error, owner);
          }
        } finally {
          clearTimeout(pushedAt);
          stopPullRequestWatch();
          // A process restart sweeps a workspace that this removal leaves.
          if (conflictWork) await rm(conflictWork, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
          if (workspaceEntry) {
            try {
              // Only a push or a recorded wait may be resumed; completing without error is not a repair.
              if (workspaceRun.prepared && workspaceRun.head) {
                await workspaceEntry.record({ head: pushedHead ?? workspaceRun.head, base: workspaceRun.base, ok: workspaceRun.ok, resumable: workspaceRun.ok && outcome === "waiting", release, session: workspaceRun.thread, outcome });
              }
              // A pass that never touched the workspace leaves the previous result in place.
              else if (workspaceEntry.previous) await workspaceEntry.record(workspaceEntry.previous);
            } catch (error) {
              schedulerError("babysitter.workspace.record_failed", error, owner);
            } finally {
              await workspaceEntry.release();
            }
          }
          try {
            await placementLease?.release();
          } catch (error) {
            // Placement is user supplied; a failed release must not strand the
            // durable inbox claim or the in-memory owner slot.
            // Error reporting is user supplied too, so it must not interrupt
            // the cleanup below when the reporter itself throws.
            try {
              schedulerError("babysitter.placement.release.failed", error, owner);
            } catch {
              // Cleanup remains authoritative even when reporting fails.
            }
          }
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
              ...(workspaceRun.reason ? { workspace: workspaceRun.reason === "warm" ? "warm" : "reset", workspace_reason: workspaceRun.reason, workspace_ms: workspaceRun.durationMs } : {}),
              ...(workspaceRun.session ? { resumed: workspaceRun.session.resume, session_reason: workspaceRun.session.reason } : {}),
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

  return { inbox: pullRequestInbox, repositories: repositorySource, reconcile, workload, observeMainRepair };
}

function fixedOrSource(repositories: readonly string[] | BabysitterRepositories): BabysitterRepositories {
  if (!Array.isArray(repositories)) return repositories as BabysitterRepositories;
  const fixed = repositories.map(repository => repository.toLowerCase());
  return { source: "allow", known: () => fixed, current: async () => fixed, observe: () => false };
}

function assertBabysitterAgent(agent: AgentInput): asserts agent is BabysitterAgent {
  if (
    !agentSettings(agent) ||
    !("options" in agent) ||
    !agent.options ||
    !hasRuntimeType(agent.options, "object") ||
    !("merge" in agent.options) ||
    !("filter" in agent.options) ||
    !agent.options.filter ||
    !hasRuntimeType(agent.options.filter, "object") ||
    Array.isArray(agent.options.filter)
  ) {
    throw new Error("Babysitter runtime requires a configured Babysitter Agent Definition.");
  }
}
