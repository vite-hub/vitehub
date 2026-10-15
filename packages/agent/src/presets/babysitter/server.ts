import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { resolvePublicUrl, resolveRuntimeValue } from "@vite-hub/runtime";
import { hasRuntimeType, isRuntimeRecord } from "../../internal/runtime-type.ts";
import { resolveRegisteredWorkspaceDefinition } from "@vite-hub/workspace";
import type { ProcessReconcilerRunContext } from "@vite-hub/runtime/node";
import { createMessage, defineAgent, runAgent } from "../../index.ts";
import { resolveAgentCapabilityDefinitions } from "../../capability-runtime.ts";
import type { AgentCapabilitiesResolver, AgentInput, ClaudeCodeDriverOptions, CodexDriverOptions } from "../../index.ts";
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
import { repairCapability, repairEnvironment } from "./repair.ts";
import { createGitHubRequiredCheckPolicyReader, evaluateGitHubRequiredChecks } from "../../server/github-required-checks.ts";
import { directMergeReadiness, liveMergeReadiness, resolveBabysitterMerge, snapshotCheckEvidence, mergeReviewEvidenceKey } from "./merge.ts";
import { checksDependencyEvidence, createCheckWait, hasPendingChecks, wakeReasons, type BabysitterWaitPolicy } from "./wait.ts";
import { nonDefaultBase, stackRetargetBase, directMergeBranchSafety } from "./stack.ts";

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
}

/** Bound policy hooks inside an owner slot, never in the scheduler wait scan. */
export async function boundedMergeReady(read: () => true | string | Promise<true | string>, signal: AbortSignal, timeoutMs = 10_000): Promise<true | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("Merge readiness timed out.")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
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
    ...(options.inboxStorage ? { storage: options.inboxStorage, scope: options.inboxScope ?? options.agentName ?? baseAgent.name ?? "babysitter" } : { path: options.inboxPath }),
    repositories: options.repositories,
    filter: presetOptions.filter,
    activityAuthors,
  });
  const waitPolicy: BabysitterWaitPolicy = {
    workerAuthors: new Set(activityAuthors.flatMap(author => [author.toLowerCase(), `${author.toLowerCase().replace(/\[bot\]$/, "")}[bot]`])),
    pendingReviewChecks: new Set((presetOptions.reviewChecks ?? []).map(name => name.toLowerCase())),
    wakeWhenReady: merge.mode === "direct",
    noFindingsReviews: baseAgent.noFindingsReviews ?? presetOptions.noFindingsReviews ?? [],
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
      async () => {
        const verifiedPush = pushedHead();
        if (verifiedPush) return verifiedPush;
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
      // The hosted gh CLI does not provide `--slurp`; ask it to emit one JSON
      // value per line and assemble the already-paginated response here.
      const rules = path.includes("/rules/");
      const result = await github.command(
        ["api", "--paginate", path, "--jq", rules ? ".[] | @json" : ". | @json"],
        { repository, timeout: 60_000 },
      );
      const values = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      // Rules are a list; protection and branch endpoints return one object.
      return { status: 200, data: rules ? values : values[0], nextPage: null };
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
    if (pending) {
      try {
        const [live] = await readRest(`repos/${repository}/pulls/${number}`, ".", signal);
        const state = isRuntimeRecord(live) && hasRuntimeType(live.state, "string") ? live.state : undefined;
        const mergedAt = isRuntimeRecord(live) && hasRuntimeType(live.merged_at, "string") ? live.merged_at : undefined;
        if (state?.toLowerCase() !== "open" && mergedAt) {
          await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
          await pullRequestInbox.finish(claim, { text: "Direct merge outcome reconciled: GitHub no longer reports the pull request as open.", terminal: true });
          return "merged";
        }
        // A confirmed open PR means GitHub did not accept this request. Clear the
        // fence only after the provider read has established that it is safe to retry.
        await pullRequestInbox.clearDirectMerge(repository, number, pending.token);
        await pullRequestInbox.finish(claim, { text: "Direct merge outcome reconciled as not merged; retrying the verified pull request.", retry: true });
      } catch (error) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: `merge outcome unknown: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}` });
        await pullRequestInbox.release(claim);
      }
      return "blocked";
    }
    if (signal.aborted) return "blocked";
    const policy = await requiredChecks.read(repository, base);
    const evaluation = evaluateGitHubRequiredChecks(policy, snapshotCheckEvidence(snapshot));
    const assessment = await pullRequestInbox.meta(`review-assessment:${repository}#${number}`);
    const reviewedEvidenceKey = isRuntimeRecord(assessment) && assessment.head === snapshot.pr?.head?.sha && hasRuntimeType(assessment.evidenceKey, "string") ? assessment.evidenceKey : undefined;
    let decision = directMergeReadiness(snapshot, evaluation.state, { pendingReviewChecks: waitPolicy.pendingReviewChecks, workerAuthors: waitPolicy.workerAuthors, reviewedEvidenceKey });
    if (decision.ready && merge.ready) {
      const head = decision.head;
      const readyHook = merge.ready;
      const ready = await boundedMergeReady(() => readyHook({ repository, number, head, snapshot: structuredClone(snapshot), requiredChecks: evaluation.state }), signal);
      if (ready !== true) decision = { ready: false, reason: ready };
    }
    if (!decision.ready) {
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: decision.reason });
      return "not-ready";
    }
    let mergeStarted = false;
    try {
      const [live] = await readRest(`repos/${repository}/pulls/${number}`, ".", signal);
      const current = liveMergeReadiness(live, decision.head);
      if (!current.ready) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: current.reason });
        return "not-ready";
      }
      const [repositorySettings] = await readRest(`repos/${repository}`, ".", signal);
      const children = await readRest(`repos/${repository}/pulls?state=open&base=${encodeURIComponent(snapshot.pr?.head?.ref ?? "")}&per_page=100`, ".[]", signal);
      const branchSafety = directMergeBranchSafety(repositorySettings, live, children);
      if (branchSafety !== true) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: branchSafety });
        return "not-ready";
      }
      // Revalidate the durable lease and revision after the live provider read and
      // immediately before the irreversible merge request. A webhook or another
      // worker that changed the inbox invalidates this claim.
      if (!(await pullRequestInbox.isClaimCurrent(claim))) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "claim changed before merge" });
        return "not-ready";
      }
      signal.throwIfAborted();
      if (!(await pullRequestInbox.beginDirectMerge(claim, decision.head))) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "merge attempt already in flight or claim changed" });
        return "blocked";
      }
      mergeStarted = true;
      // GitHub rejects the merge when the head no longer matches sha.
      const result = await github.command(["api", "-X", "PUT", `repos/${repository}/pulls/${number}/merge`, "-f", `merge_method=${merge.method}`, "-f", `sha=${decision.head}`], { repository, timeout: 60_000, signal });
      let response: unknown;
      try {
        response = JSON.parse(result.stdout);
      } catch {
        response = undefined;
      }
      if (!isRuntimeRecord(response) || response.merged !== true) {
        schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: "GitHub did not confirm the pull request was merged" });
        return "blocked";
      }
    } catch (error) {
      if (!mergeStarted) await pullRequestInbox.release(claim);
      schedulerEvent("babysitter.direct_merge.skipped", { ...owner, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      return "blocked";
    }
    await pullRequestInbox.clearDirectMerge(repository, number, claim.token);
    await pullRequestInbox.finish(claim, { text: `Merged ${decision.head} directly: required checks passed and review threads were resolved.`, terminal: true });
    schedulerEvent("babysitter.owner.merged", { ...owner, head_sha: decision.head, avoided_invocation: true });
    return "merged";
  }

  const postPushGraceMs = options.postPushGraceMs ?? 3 * 60_000;

  async function parkOnPushedHead(claim: Claim, text: string, head: string) {
    await pullRequestInbox.finish(claim, { text, progress: { kind: "verified", evidence: `push:${head}` },
      wait: { ...createCheckWait(claim.snapshot, waitPolicy), headSha: head } });
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

  async function requiredCheckState(snapshot: Snapshot) {
    const base = snapshot.pr?.base?.ref;
    if (!base) return "unknown" as const;
    return evaluateGitHubRequiredChecks(await requiredChecks.read(snapshot.repository, base), snapshotCheckEvidence(snapshot)).state;
  }

  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  async function dependencyEvidence(wake: PullRequestWake): Promise<string> {
    // Dependency reads are host-owned. A parked model never polls unchanged checks.
    if (wake.kind === "pull-request") {
      const [pr] = await readRest(`repos/${wake.repository}/pulls/${wake.number}`, ".");
      if (!isRuntimeRecord(pr)) throw new Error("Missing external pull-request state.");
      return digest({ state: pr.state, mergedAt: pr.merged_at, head: isRuntimeRecord(pr.head) ? pr.head.sha : undefined });
    }
    return checksDependencyEvidence(wake, readRest);
  }
  async function externalWait(observed: Snapshot, wake: PullRequestWake | undefined, reason: string) {
    if (!wake) return { ...createCheckWait(observed, waitPolicy), kind: "external" as const, reason };
    if (!options.repositories.includes(wake.repository.toLowerCase())) throw new Error("External wake repository is outside the configured repositories.");
    const evidence = await dependencyEvidence(wake);
    await pullRequestInbox.setMeta(`dependency:${observed.repository}#${observed.number}`, evidence);
    return { ...createCheckWait(observed, waitPolicy), kind: "external" as const, reason, wake };
  }

  /** Wakes a parked PR only when its new events need a model pass or a direct merge. */
  async function evaluateWaits() {
    for (const snapshot of await pullRequestInbox.waitsToEvaluate(true)) {
      if (snapshot.generation <= snapshot.handled && (snapshot.wait?.retryAt ?? Infinity) > Date.now() && !snapshot.wait?.wake) continue;
      const checks = await requiredCheckState(snapshot);
      const reasons = wakeReasons(snapshot, checks, waitPolicy);
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
  async function retargetMergedStackBase(snapshot: Snapshot): Promise<{ from: string; to: string } | { parent: number } | undefined> {
    const pr = snapshot.pr;
    const target = pr && nonDefaultBase(pr);
    if (!pr || !target) return undefined;
    const { base, owner } = target;
    const parents = await readRest(`repos/${snapshot.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=10`);
    const to = stackRetargetBase(pr, parents);
    if (!to) {
      const parent = parents.find(value => isRuntimeRecord(value) && String(value.state).toLowerCase() === "open" && Number.isSafeInteger(value.number));
      return isRuntimeRecord(parent) && hasRuntimeType(parent.number, "number") ? { parent: parent.number } : undefined;
    }
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
        let passResult: BabysitterPassResult | undefined;
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
          const retargeted = await retargetMergedStackBase(inboxClaim.snapshot);
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
          if (!(await hydrateFailedCiEvidence(pullRequestInbox, inboxClaim, {
            readJson: (path, projection) => readRest(path, projection, passSignal),
            readLog: async (path, repository) => (await github.command(["api", path], { repository, timeout: 60_000, signal: passSignal })).stdout,
          }))) { await pullRequestInbox.release(inboxClaim); return; }
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
                const stopped = claimStopReason(inboxClaim, current, pushedHead);
                if (stopped) throw new DOMException(stopped, "AbortError");
                // A proven repair head may finish resolving addressed feedback after synchronize.
                // A generation change on the original head still invalidates the worker's evidence.
                if (current.generation !== inboxClaim.generation && (!pushedHead || current.pr?.head?.sha !== pushedHead)) {
                  throw new DOMException("Pull request evidence changed.", "AbortError");
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
                expectedBaseOid: pullRequest.baseRefOid,
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
              const workerName = `${options.agentName ?? baseAgent.name ?? "babysitter"}-worker`;
              const baseSettings = getAgentLayerOptions(baseAgent);
              if (!baseSettings) throw new Error("Babysitter base Agent settings are unavailable.");
              // Build the worker from the base settings while replacing only
              // its GitHub Channel. Extending the base Agent would preserve
              // the host identity, but dropping the whole map loses other
              // channel-scoped capabilities needed by repair passes.
              const { channels: _baseChannels, github: _baseGitHub, ...workerSettings } = baseSettings;
              const baseChannels = isRuntimeRecord(_baseChannels) ? _baseChannels : {};
              const workerBaseChannels = Object.fromEntries(Object.entries(baseChannels).map(([name, channel]) => {
                if (!isRuntimeRecord(channel) || channel.kind !== "github") return [name, channel];
                const sanitized = { ...channel };
                // A GitHub channel under any key can otherwise reintroduce host credentials.
                Reflect.deleteProperty(sanitized, Symbol.for("vitehub.githubChannelIdentity"));
                return [name, sanitized];
              }));
              const baseCapabilities = workerSettings.capabilities;
              const repair = repairCapability(operations, merge.mode === "auto");
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
              const configuredWorkspace = workerSettings.workspace;
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
              const agent = defineAgent({
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
                  permissions: "allow-edits-unattended",
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
                  ...baseWorkspace,
                  commit: false,
                  mode: "write" as const,
                  store: { provider: "local" as const, root: checkout },
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
              ), abortSignal);
              const validated = babysitterPassResultSchema["~standard"].validate(result);
              if ("issues" in validated)
                throw new Error("Babysitter returned an invalid pass result.");
              passResult = validated.value;
              disposition = validated.value.disposition;
              resultText = validated.value.text;
            },
            { signal: passSignal, timeout: 60 * 60 * 1000 },
          );

          const current = await pullRequestInbox.get(repository, number);
          const assessed = passResult?.wait?.kind !== "external" && !pushedHead && disposition === "park" && passResult?.reviewedHead === pullRequest.headRefOid
            && current?.pr?.head?.sha === pullRequest.headRefOid && await pullRequestInbox.isClaimCurrent(inboxClaim);
          if (assessed) await pullRequestInbox.setMeta(`review-assessment:${repository}#${number}`, { head: pullRequest.headRefOid, evidenceKey: mergeReviewEvidenceKey(inboxClaim.snapshot, waitPolicy) });
          const terminal = current?.status === "terminal";
          if (terminal) {
            await pullRequestInbox.finish(inboxClaim, { text: resultText, terminal: true });
          } else if (pushedHead) {
            outcome = "waiting";
            await parkOnPushedHead(inboxClaim, resultText, pushedHead);
          } else if (disposition === "park" && current?.pr?.head?.sha === pullRequest.headRefOid && passResult?.wait?.kind === "external") {
            outcome = "waiting";
            await pullRequestInbox.setMeta(`review-assessment:${repository}#${number}`, null);
            await pullRequestInbox.finish(inboxClaim, { text: resultText,
              wait: await externalWait(inboxClaim.snapshot, passResult.wait.wake, passResult.wait.reason) });
          } else if (disposition === "park" && current?.pr?.head?.sha === pullRequest.headRefOid && (passResult?.wait?.kind === "checks" && passResult.wait.headSha === pullRequest.headRefOid
            || passResult?.waitForChecksHead === pullRequest.headRefOid || hasPendingChecks(inboxClaim.snapshot, waitPolicy))) {
            // A reproduced external gate waits on this head until its evidence changes.
            outcome = "waiting";
            // Evidence that changed during the pass makes this wait stale, and the PR stays claimable.
            await pullRequestInbox.finish(inboxClaim, { text: resultText, progress: { kind: "no-progress" },
              wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), ...(assessed && merge.mode === "direct" ? { retryAt: Date.now() + 120_000 } : {}) } });
          } else if (assessed) {
            outcome = "waiting";
            await pullRequestInbox.finish(inboxClaim, { text: resultText, wait: { ...createCheckWait(inboxClaim.snapshot, waitPolicy), ...(assessed && merge.mode === "direct" ? { retryAt: Date.now() + 120_000 } : {}) } });
          } else {
            // A park that names no external gate still consumed a pass without progress.
            outcome = "retry";
            await pullRequestInbox.finish(inboxClaim, { text: resultText, retry: true, progress: { kind: "no-progress" } });
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
