import { claudeCodeDriver, codexDriver, defineAgent } from "@vite-hub/agent";
import type {
  ConfiguredAgentDefinition,
  AgentDefinition,
  AgentRuntimeConfig,
  AgentInvoker,
  AgentInvocationContextValues,
} from "@vite-hub/agent";
import type { GitHubPullRequestFilter, GitHubPullRequestFilterRules } from "@vite-hub/agent/channels";
import type { AgentSandboxDefinition, BuiltInAgentDriverName } from "@vite-hub/agent";
import { createBabysitterPassResultSchema } from "./babysitter/result.ts";
import type { AutomatedReviewClass } from "./babysitter/inbox/budgets.ts";
import { babysitterInstructions } from "./babysitter/instructions.ts";
import { resolveBabysitterMerge, type BabysitterMerge } from "./babysitter/merge.ts";
import { presetsErrorDiagnostics } from "./error-diagnostics.ts";
import { validBabysitterAdmission, type BabysitterAdmissionOptions } from "./babysitter/admission.ts";
import { validWarmWorkspaces, type BabysitterWarmWorkspaces } from "./babysitter/pr-workspaces.ts";
import type { BabysitterMainRepair } from "./babysitter/main-repair.ts";
import { channelAdapter, defineChannelTrigger } from "@vite-hub/agent/channels";
import { channelEnvValue } from "@vite-hub/agent/channels";
import { agentProcessHostIntake, withAgentProcessHost, type AgentProcessHostContribution } from "@vite-hub/agent/process";
import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts";
import { githubAuthorAssociations } from "./babysitter/pull-request-filter.ts";

export type { BabysitterMerge, BabysitterMergeMethod, BabysitterMergeReadinessInput, BabysitterMergeReady } from "./babysitter/merge.ts";
export type { BabysitterAdmissionOptions, BabysitterAdmissionPause } from "./babysitter/admission.ts";
export type { BabysitterWarmWorkspaces } from "./babysitter/pr-workspaces.ts";
export type { BabysitterMainRepair } from "./babysitter/main-repair.ts";
export type { AutomatedReviewClass } from "./babysitter/inbox/budgets.ts";
export { BabysitterPlacementCapacityError } from "./babysitter/placement.ts";

export interface BabysitterLifecycleLabels {
  /** At least one of these labels must be present for the PR to be eligible. */
  require?: readonly string[];
  /** Any of these labels suppresses the PR, even when a required label is present. */
  deny?: readonly string[];
}

export interface BabysitterLifecycleOptions {
  labels?: BabysitterLifecycleLabels;
}

/** Where one pass runs. A pass without a Sandbox uses the host checkout and the configured `sandbox`. */
export interface BabysitterPlacementLease {
  /** Sandbox for this pass, for example a custom runtime on another host. */
  sandbox?: AgentSandboxDefinition;
  /** Called once when the pass finishes, fails or is cancelled. */
  release(): void;
}

/** Chooses a host for each pass before the Babysitter installs dependencies on this one. */
export interface BabysitterPlacement {
  /** Throw `BabysitterPlacementCapacityError` when no host can take the pass now; the PR waits and is claimed again. */
  place(pullRequest: { repository: string; number: number }): BabysitterPlacementLease | Promise<BabysitterPlacementLease>;
  /** Passes currently placed on other hosts. They hold a concurrency slot but no local memory. */
  remoteActive?(): number;
  /**
   * Slots that hosts admit now, counting passes already running. A reconcile claims at most this
   * many PRs minus the active owners, so it never claims work that `place` must turn away.
   */
  admitted?(): number | Promise<number>;
}

/** Where the Babysitter reports its state on each PR. Both need a verified GitHub App identity. */
export interface BabysitterStatusOptions {
  /** Keep the activity comment on the PR up to date. Defaults to `true`. */
  comment?: boolean;
  /**
   * Mirror the state as a check run named `babysitter` on the PR head: queued, in progress, neutral
   * while waiting, success when done and failure when a pass failed. Its details link opens the
   * Console session. Needs the App's `checks: write` permission; a repository that answers 403 is
   * reported once and skipped. The Babysitter leaves this check out of its own CI and merge decisions,
   * so do not make it a required check. Defaults to `true`.
   */
  checkRun?: boolean;
}

export interface BabysitterOptions {
  /** Process admission policy. Concurrency remains the preset hard maximum. */
  capacity?: Pick<import("@vite-hub/agent/process").ProcessAgentCapacityOptions, "memory" | "cpu" | "fallbackConcurrency">;
  /**
   * Places each pass on this host or in a Sandbox before host dependency installation. Sandbox passes
   * skip the host install; the Sandbox installs through `refreshDependencies` when it provides one.
   */
  placement?: BabysitterPlacement;
  /**
   * Select PRs with the same rules as the GitHub Channel, with two differences. A PR passes when it
   * matches either `author.allow` or `authorAssociation.allow`; a match on either deny list rejects it.
   * Logins match case-insensitively and in either bot spelling, so `renovate[bot]` also matches `renovate`.
   * Without `repository.allow`, the Babysitter serves every repository that its GitHub App installations
   * can access, except archived ones and those in `repository.deny`, so installing the App on a repository enrolls it.
   * Without `author` or `authorAssociation` rules, only PRs whose author is an owner, member or collaborator are selected.
   */
  filter: GitHubPullRequestFilter;
  /**
   * Additional lifecycle admission rules. Use labels to pause or resume a PR without changing the filter.
   * Without these labels or `filter.labels`, a PR labelled `babysitter:skip` is skipped. `{ labels: {} }` turns that off.
   */
  lifecycle: BabysitterLifecycleOptions;
  /** Provider Driver that repairs each PR in its checkout. Defaults to `"codex"`. Set the model with `driver.model`. */
  driver: BuiltInAgentDriverName;
  /**
   * Merge policy. Defaults to `"direct"`. `false` never merges, and `"auto"` lets the worker request
   * GitHub native auto-merge. `"direct"` merges a ready PR into its default branch before any model
   * pass, and holds a PR from someone without write access until a reviewer with write access approves
   * its current head. Pass `{ strategy: "direct", ready }` with another callback to change that gate.
   */
  merge: BabysitterMerge;
  /**
   * Check names whose pending run means a review is in progress, such as a review bot's check.
   * A parked PR keeps waiting while one runs. Defaults to none.
   */
  reviewChecks: string[];
  /**
   * Body prefixes of comment-only reviews that report no findings, such as a review bot's
   * `"> ✅ No new issues found."`. These reviews do not wake a parked PR. Defaults to none.
   */
  noFindingsReviews: string[];
  /**
   * Logins whose comments and reviews never need an assessment, such as deployment preview bots.
   * Their items do not block a direct merge or wake a waiting PR. Defaults to none.
   */
  ignoreFeedbackAuthors: string[];
  /**
   * Passes on one head that may end without a push or a recorded wait before the PR stops until its
   * head changes or a person comments. `false` disables the budget. Defaults to 3.
   */
  noProgressBudget: number | false;
  /**
   * Review-driven pushes on one PR after which bot feedback and failed `reviewChecks` no longer wake a
   * model pass. A push is review-driven when its pass had no merge conflict and no failing check outside
   * `reviewChecks`. A person's comment or review, another failing check, a conflict or a head that
   * someone else pushed still start a pass. The PR then merges on its required checks or parks with
   * the reason. `false` disables the budget. Defaults to 3.
   */
  reviewPushBudget: number | false;
  /**
   * Heads in a row whose automated review has no valid finding above P2 before automated review settles
   * as if `reviewPushBudget` were spent. Each pass reports the highest class (P0 to P3) in the
   * automated reviews of its head; a P0 or P1 starts the count again. Needs `reviewPushBudget`.
   * `false` disables it. Defaults to `false`.
   */
  minorReviewRounds: number | false;
  /**
   * Review-driven pushes after which each pass is asked to fix a recurring class of review finding at
   * its root instead of patching one more case, or to decline the remaining minor cases. `false`
   * disables it. Defaults to `false`.
   */
  reviewConvergencePushes: number | false;
  /**
   * Unresolved review threads with only bot comments stop blocking a direct merge and stop waking a
   * waiting PR once a pass assessed their comments. A new bot comment still needs a pass, and a thread
   * with a person's comment still blocks. Defaults to `false`; such threads then stop blocking only
   * once automated review settles.
   */
  ignoreAssessedBotThreads: boolean;
  /**
   * Model passes on one PR in a rolling 24 hours. After that many, the PR parks until the oldest pass
   * is 24 hours old; its result and the health route show that time. A person's comment or review, the
   * first failing required check on a head, a merge conflict, and one assessment of a head whose required
   * checks pass still start a pass, and count. A pass that the provider fails within 10 minutes does not
   * count. `false` disables the budget. Defaults to 16.
   */
  dailyPassBudget: number | false;
  /**
   * Repair pushes on one PR in a rolling 24 hours. Past it, `pushRepair` refuses a push until the
   * oldest is 24 hours old, and a pass that could only push parks until then. A conflict repair still
   * pushes, and a PR whose required checks fail may push once every two hours. `false` disables the
   * budget. Defaults to `false`.
   */
  dailyPushBudget: number | false;
  /**
   * PR labels that put a PR first in the claim order, after main repairs. A labelled PR is exempt from
   * `dailyPassBudget` and `dailyPushBudget`; checks, reviews and merge gates still apply. Matched
   * case-insensitively. Defaults to none.
   */
  priorityLabels: string[];
  /**
   * Head branch prefix of PRs that repair the base branch, such as `"repair-main-"`. These PRs are
   * claimed before every other PR, and `noProgressBudget` never stops them. Defaults to none.
   */
  mainRepairBranchPrefix?: string;
  /**
   * Open a PR that repairs the default branch when one of `workflows` fails on it. The check runs every
   * 10 minutes per repository, and at once when a failed push run of a watched workflow is delivered.
   * The PR starts with an empty commit on a branch named `mainRepairBranchPrefix` and the red commit's
   * short SHA, so the queue claims it first. One repair PR is open at a time, and a red commit gets
   * one repair branch. Running jobs of watched push runs older than `stuckJobMinutes` are force-cancelled
   * first. Needs `mainRepairBranchPrefix`. Defaults to `false`.
   */
  mainRepair: BabysitterMainRepair | false;
  /**
   * Wait for running required checks and review checks before a pass, unless a failure or conflict
   * already needs repair. One pass then handles CI and review results together. Defaults to `true`.
   */
  deferWhilePending: boolean;
  /**
   * Install dependencies on the host before the provider starts. `true` detects pnpm, npm or
   * Yarn from the lockfile and installs it frozen. A command overrides the detection. A detected pnpm
   * install reuses the trees of earlier passes. A failed install does not stop the pass unless
   * `required` is set. Defaults to `true`.
   */
  install: BabysitterInstall;
  /** Rerun failed GitHub Actions runs once before a model pass repairs them. Defaults to `true`. */
  ciRecovery: boolean;
  /**
   * Keep one workspace per open PR under `<dataDir>/pr-workspaces` instead of cloning, copying and
   * installing for every pass. A pass on the head the previous pass pushed or left, after a pass that
   * finished, on a clean tree, keeps node_modules and build caches and skips a current install. Any
   * other pass empties the workspace and checks the head out again. Entries go when the PR closes,
   * after `idleDays` without a pass, and least recently used first above `budgetGb` or below
   * `minFreePercent` free disk. `resumeThreads` also continues the previous pass's provider thread.
   * Passes placed in a Sandbox keep using their own workspace. Defaults to `false`.
   */
  warmWorkspaces: boolean | BabysitterWarmWorkspaces;
  /**
   * Repair a PR whose base is another open PR's branch in parallel with its parent: checks, conflicts
   * and feedback. It never merges into the parent's branch and waits for the parent once its reviewed
   * head has nothing left to repair. Requires `merge: "direct"`. Defaults to `false`, which leaves a
   * stack child unclaimed until its parent merges.
   */
  repairStackChildren: boolean;
  /**
   * Model passes that run at the same time. Set it to what the provider accounts can serve; host
   * work such as merges and stack retargets still uses `concurrency`. Defaults to `concurrency`.
   */
  modelConcurrency?: number;
  /**
   * Retries of a provider rate limit, 10 seconds apart, before the pass opens the provider cooldown.
   * Set `0` when the provider already retries, as Codex does. Defaults to 3.
   */
  providerRetries: number;
  /**
   * First cooldown after a pass runs out of provider rate-limit retries. Model passes pause; host work
   * continues. Each further cooldown doubles, up to one hour, and halves model concurrency. A
   * success 30 minutes after the last cooldown removes one step. Defaults to 300000 (five minutes).
   */
  providerCooldownMs: number;
  /** GitHub logins the worker may notify through its explicit mention capability. Defaults to none. */
  mentionAllowlist: string[];
  /** PRs repaired at the same time. Defaults to 1. */
  concurrency: number;
  /**
   * Token budgets, a free-space guard and custom checks that gate model passes. A spent limit
   * stops model passes; direct merges and recorded waits continue. Defaults to no token limit
   * and 4096 MiB of free temporary space.
   */
  admission: BabysitterAdmissionOptions;
  /** How the Babysitter reports its state on the PR. Defaults to `{ comment: true, checkRun: true }`. */
  status: BabysitterStatusOptions;
}

/**
 * Dependency install before each pass. `true` detects the package manager from the lockfile;
 * `false` skips the install.
 */
export type BabysitterInstall = boolean | {
  /** Install command. Defaults to the package manager detected from the lockfile. */
  command?: string;
  args?: string[];
  /**
   * Reuse the node_modules trees of a detected pnpm install across passes with the same lockfile,
   * using independent copy-on-write copies on Linux. `directory` defaults to `BABYSITTER_INSTALL_CACHE` or
   * `<tmpdir>/vitehub-install-cache` and must share a filesystem with the pass workspaces. The default
   * directory is used only when it supports reflinks; a configured `directory` is used on any filesystem.
   * `entries` defaults to `BABYSITTER_INSTALL_CACHE_ENTRIES` or 8. `false` disables the cache.
   */
  cache?: false | { directory?: string; entries?: number };
  /**
   * Detected installs that run at the same time across passes. A pass waits up to ten minutes for a
   * free slot and keeps its checkout while it waits. Defaults to 2.
   */
  concurrency?: number;
  /**
   * `false` continues a pass without dependencies when the install fails: the model reads the
   * failure in `.git/vitehub-install.json`, repairs the PR's lockfile or manifests or relies on hosted
   * CI, and commits without local dependency verification. `true` parks the PR on the failure until
   * its inputs change. Defaults to `false`.
   */
  required?: boolean;
  /**
   * `refreshDependencies` calls per pass. Further calls return a tool error that tells the model to
   * commit its dependency fixes and let hosted CI validate them. Retryable install failures do not
   * count. Defaults to no limit.
   */
  refreshes?: number;
};

export type BabysitterPassWake =
  | { kind: "checks"; repository: string; headSha: string }
  | { kind: "pull-request"; repository: string; number: number };

export type BabysitterPassWait =
  | { kind: "checks"; headSha: string }
  | { kind: "external"; reason: string; wake?: BabysitterPassWake };

export interface BabysitterPassResult {
  disposition: "park" | "retry";
  text: string;
  /** Structured external dependency. The host never interprets result prose as control flow. */
  wait?: BabysitterPassWait;
  /** Current HEAD whose full feedback and failed checks were inspected and addressed. */
  reviewedHead?: string;
  /** Legacy explicit check checkpoint, accepted while existing provider output migrates. */
  waitForChecksHead?: string;
  /** Highest class of valid finding in the automated reviews of the head the pass started on. Read with `minorReviewRounds`. */
  automatedReview?: AutomatedReviewClass;
}

export const babysitterPassResultSchema: ReturnType<typeof createBabysitterPassResultSchema> = createBabysitterPassResultSchema();

function validInstall(install: unknown): boolean {
  if (hasRuntimeType(install, "boolean")) return true;
  if (!isRuntimeRecord(install)) return false;
  const { command, args, cache, concurrency, required, refreshes } = install;
  if (refreshes !== undefined && !(Number.isSafeInteger(refreshes) && Number(refreshes) >= 1)) return false;
  if (command !== undefined && !(hasRuntimeType(command, "string") && command.trim())) return false;
  if (concurrency !== undefined && !(Number.isSafeInteger(concurrency) && Number(concurrency) >= 1)) return false;
  if (required !== undefined && !hasRuntimeType(required, "boolean")) return false;
  if (args !== undefined && (command === undefined || !Array.isArray(args) || !args.every(arg => hasRuntimeType(arg, "string")))) return false;
  if (cache === undefined || cache === false) return true;
  if (!isRuntimeRecord(cache)) return false;
  return (cache.directory === undefined || (hasRuntimeType(cache.directory, "string") && cache.directory.trim() !== ""))
    && (cache.entries === undefined || (Number.isSafeInteger(cache.entries) && Number(cache.entries) >= 1));
}

function validMainRepair(mainRepair: unknown): boolean {
  if (!isRuntimeRecord(mainRepair) || Array.isArray(mainRepair)) return false;
  const { workflows, repositories, stuckJobMinutes } = mainRepair;
  const names = (list: unknown, pattern: RegExp) => Array.isArray(list) && list.length > 0 && list.every(value => hasRuntimeType(value, "string") && pattern.test(value));
  return names(workflows, /\S/)
    && (repositories === undefined || names(repositories, /^[\w.-]+\/[\w.-]+$/))
    && (stuckJobMinutes === undefined || stuckJobMinutes === false || (Number.isSafeInteger(stuckJobMinutes) && Number(stuckJobMinutes) >= 1));
}

const babysitterHost: AgentProcessHostContribution = {
  async create(context) {
    const { createBabysitterProcessHost } = await import("./babysitter/host.ts");
    return await createBabysitterProcessHost(context);
  },
};

function plainSecret(value: unknown): string | undefined {
  const plain = isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value;
  return hasRuntimeType(plain, "string") && plain.trim() ? plain.trim() : undefined;
}

const babysitterIntake = channelAdapter("babysitter-github", {
  messages: false,
  triggers: {
    delivery: defineChannelTrigger({
      webhooks: [{
        id: "github",
        provider: "github",
        signature: "github-sha256",
        secretHeader: "x-hub-signature-256",
        // A missing secret fails closed: unsigned deliveries must never reach the inbox.
        secretToken: async (context) => {
          const secret = plainSecret(await channelEnvValue("github", "webhookSecret", context));
          if (!secret) throw new Error("[vitehub] The Babysitter webhook needs VITEHUB_GITHUB_WEBHOOK_SECRET.");
          return secret;
        },
      }],
      invoke: async (context, input: unknown) => {
        const github = isRuntimeRecord(input) && isRuntimeRecord(input.github) ? input.github : undefined;
        const deliveryId = github?.deliveryId, event = github?.event;
        if (!hasRuntimeType(deliveryId, "string") || !hasRuntimeType(event, "string") || !isRuntimeRecord(input)) {
          return Response.json({ accepted: false, reason: "missing GitHub delivery headers" }, { status: 400 });
        }
        const intake = agentProcessHostIntake(context.agentIdentity?.name ?? "");
        if (!intake) return Response.json({ accepted: false, reason: "Babysitter host is not running" }, { status: 503 });
        return await intake({ deliveryId, event, payload: input.payload });
      },
    }),
  },
});

/** A repair workflow. Connections, provider settings and host resources stay in the application. */
type BabysitterDefinition = AgentDefinition<
  AgentRuntimeConfig,
  unknown,
  AgentInvoker,
  AgentInvocationContextValues,
  BabysitterPassResult
> & {
  reviewChecks: string[];
  noFindingsReviews: string[];
  ignoreFeedbackAuthors: string[];
  noProgressBudget: number | false;
  reviewPushBudget: number | false;
  dailyPassBudget: number | false;
  deferWhilePending: boolean;
  install: BabysitterInstall;
  mentionAllowlist: string[];
  lifecycle: BabysitterLifecycleOptions;
};

export type BabysitterAgent = ConfiguredAgentDefinition<BabysitterOptions, BabysitterDefinition>;

function lifecycleLabels(labels: unknown): GitHubPullRequestFilterRules {
  if (!isRuntimeRecord(labels)) {
    throw new TypeError("[vitehub] Babysitter lifecycle labels must be an object.");
  }
  const require = labels.require;
  const deny = labels.deny;
  if ((require !== undefined && !Array.isArray(require)) || (deny !== undefined && !Array.isArray(deny))) {
    throw new TypeError("[vitehub] Babysitter lifecycle labels must contain arrays of non-empty strings.");
  }
  const requiredLabels = require ?? [];
  const deniedLabels = deny ?? [];
  if (requiredLabels.some(label => !hasRuntimeType(label, "string") || !label.trim()) || deniedLabels.some(label => !hasRuntimeType(label, "string") || !label.trim())) {
    throw new TypeError("[vitehub] Babysitter lifecycle labels must contain non-empty strings.");
  }
  const rules: GitHubPullRequestFilterRules = {};
  if (requiredLabels.length) rules.allow = [...requiredLabels];
  if (deniedLabels.length) rules.deny = [...deniedLabels];
  return rules;
}

function validAuthorAssociationRules(rules: unknown): boolean {
  if (rules === undefined) return true;
  if (!isRuntimeRecord(rules) || Array.isArray(rules)) return false;
  return [rules.allow, rules.deny].every(list => list === undefined || (Array.isArray(list) && list.every(value => (githubAuthorAssociations as readonly unknown[]).includes(value))));
}

/** Authors that a filter without `author` or `authorAssociation` rules selects: people with write access. */
const defaultAuthorAssociations = ["OWNER", "MEMBER", "COLLABORATOR"];
/** The label that pauses a PR when neither `lifecycle.labels` nor `filter.labels` is configured. */
const defaultSkipLabel = "babysitter:skip";

/**
 * Combines explicit lifecycle labels with the shared GitHub PR filter. A filter without author rules
 * selects only PRs from people with write access, and one without label rules skips PRs labelled
 * `babysitter:skip`.
 */
export function resolveBabysitterLifecycleFilter(
  configured: GitHubPullRequestFilter,
  lifecycle: BabysitterLifecycleOptions | undefined,
): GitHubPullRequestFilter {
  const filter = configured.author || configured.authorAssociation
    ? configured
    : { ...configured, authorAssociation: { allow: [...defaultAuthorAssociations] } };
  if (lifecycle !== undefined && !isRuntimeRecord(lifecycle)) {
    throw new TypeError("[vitehub] Babysitter lifecycle must be an object.");
  }
  const labels = lifecycle?.labels;
  if (labels === undefined) return filter.labels ? filter : { ...filter, labels: { deny: [defaultSkipLabel] } };
  if (filter.labels) {
    throw new TypeError("[vitehub] Configure Babysitter lifecycle labels or filter.labels, not both.");
  }
  const rules = lifecycleLabels(labels);
  return Object.keys(rules).length ? { ...filter, labels: rules } : filter;
}

export const babysitter: BabysitterAgent = defineAgent({
  options: {
    filter: {} as GitHubPullRequestFilter,
    driver: "codex" as BuiltInAgentDriverName,
    merge: "direct" as BabysitterMerge,
    reviewChecks: [] as string[],
    noFindingsReviews: [] as string[],
    ignoreFeedbackAuthors: [] as string[],
    noProgressBudget: 3 as number | false,
    reviewPushBudget: 3 as number | false,
    minorReviewRounds: false as number | false,
    reviewConvergencePushes: false as number | false,
    ignoreAssessedBotThreads: false,
    dailyPassBudget: 16 as number | false,
    dailyPushBudget: false as number | false,
    priorityLabels: [] as string[],
    mainRepairBranchPrefix: undefined as string | undefined,
    mainRepair: false as BabysitterMainRepair | false,
    deferWhilePending: true,
    install: true as BabysitterInstall,
    mentionAllowlist: [] as string[],
    concurrency: 1,
    admission: {} as BabysitterAdmissionOptions,
    lifecycle: {} as BabysitterLifecycleOptions,
    placement: undefined as BabysitterPlacement | undefined,
    ciRecovery: true,
    warmWorkspaces: false as boolean | BabysitterWarmWorkspaces,
    repairStackChildren: false,
    modelConcurrency: undefined as number | undefined,
    providerRetries: 3,
    providerCooldownMs: 5 * 60_000,
    status: {} as BabysitterStatusOptions,
  },
  configure: ({ filter, lifecycle, driver, merge, reviewChecks, noFindingsReviews, mentionAllowlist, ignoreFeedbackAuthors, noProgressBudget, reviewPushBudget, minorReviewRounds, reviewConvergencePushes, ignoreAssessedBotThreads, dailyPassBudget, dailyPushBudget, priorityLabels, mainRepairBranchPrefix, mainRepair, providerRetries, deferWhilePending, install, concurrency, admission, placement, ciRecovery, warmWorkspaces, repairStackChildren, status, modelConcurrency, providerCooldownMs }) => {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new TypeError("[vitehub] Babysitter concurrency must be a positive integer.");
    }
    if (driver !== "codex" && driver !== "claude-code") {
      throw new TypeError('[vitehub] Babysitter driver must be "codex" or "claude-code".');
    }
    if (noFindingsReviews.some((prefix) => prefix.length === 0)) {
      throw new TypeError("[vitehub] Babysitter noFindingsReviews cannot contain an empty prefix.");
    }
    if (!Array.isArray(ignoreFeedbackAuthors) || ignoreFeedbackAuthors.some(author => !hasRuntimeType(author, "string") || !author.trim())) {
      throw new TypeError("[vitehub] Babysitter ignoreFeedbackAuthors must list GitHub logins.");
    }
    if (noProgressBudget !== false && (!Number.isSafeInteger(noProgressBudget) || noProgressBudget < 1)) {
      throw new TypeError("[vitehub] Babysitter noProgressBudget must be a positive integer or false.");
    }
    if (reviewPushBudget !== false && (!Number.isSafeInteger(reviewPushBudget) || reviewPushBudget < 1)) {
      throw new TypeError("[vitehub] Babysitter reviewPushBudget must be a positive integer or false.");
    }
    if (minorReviewRounds !== false && (!Number.isSafeInteger(minorReviewRounds) || minorReviewRounds < 1)) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "minorReviewRounds", expected: "a positive integer or false" });
    }
    if (minorReviewRounds !== false && reviewPushBudget === false) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_MINOR_ROUNDS_NEED_BUDGET();
    }
    if (reviewConvergencePushes !== false && (!Number.isSafeInteger(reviewConvergencePushes) || reviewConvergencePushes < 1)) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "reviewConvergencePushes", expected: "a positive integer or false" });
    }
    if (!hasRuntimeType(ignoreAssessedBotThreads, "boolean")) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "ignoreAssessedBotThreads", expected: "a boolean" });
    }
    if (dailyPassBudget !== false && (!Number.isSafeInteger(dailyPassBudget) || dailyPassBudget < 1)) {
      throw new TypeError("[vitehub] Babysitter dailyPassBudget must be a positive integer or false.");
    }
    if (dailyPushBudget !== false && (!Number.isSafeInteger(dailyPushBudget) || dailyPushBudget < 1)) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "dailyPushBudget", expected: "a positive integer or false" });
    }
    if (!Array.isArray(priorityLabels) || priorityLabels.some(label => !hasRuntimeType(label, "string") || !label.trim())) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "priorityLabels", expected: "a list of GitHub label names" });
    }
    if (mainRepairBranchPrefix !== undefined && !(hasRuntimeType(mainRepairBranchPrefix, "string") && mainRepairBranchPrefix.trim())) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "mainRepairBranchPrefix", expected: "a non-empty branch name prefix" });
    }
    if (mainRepair !== false && !validMainRepair(mainRepair)) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "mainRepair", expected: 'false or { workflows, repositories?, stuckJobMinutes? } with workflow names, "owner/name" repositories and a positive integer or false' });
    }
    if (mainRepair !== false && mainRepairBranchPrefix === undefined) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_MAIN_REPAIR_NEEDS_PREFIX();
    }
    if (!hasRuntimeType(deferWhilePending, "boolean")) {
      throw new TypeError("[vitehub] Babysitter deferWhilePending must be a boolean.");
    }
    if (!validInstall(install)) {
      throw new TypeError("[vitehub] Babysitter install must be a boolean or { command, args, cache, concurrency, required, refreshes }.");
    }
    if (!hasRuntimeType(ciRecovery, "boolean")) {
      throw new TypeError("[vitehub] Babysitter ciRecovery must be a boolean.");
    }
    if (!validWarmWorkspaces(warmWorkspaces)) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "warmWorkspaces", expected: "a boolean or { resumeThreads, budgetGb, idleDays, minFreePercent, sweepMinutes } with non-negative numbers" });
    }
    if (!isRuntimeRecord(status) || [status.comment, status.checkRun].some(value => value !== undefined && !hasRuntimeType(value, "boolean"))) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_STATUS_INVALID();
    }
    if (!hasRuntimeType(repairStackChildren, "boolean")) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "repairStackChildren", expected: "a boolean" });
    }
    if (modelConcurrency !== undefined && (!Number.isSafeInteger(modelConcurrency) || modelConcurrency < 1)) {
      throw new TypeError("[vitehub] Babysitter modelConcurrency must be a positive integer.");
    }
    if (!Number.isSafeInteger(providerRetries) || providerRetries < 0) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "providerRetries", expected: "a non-negative integer" });
    }
    if (!Number.isSafeInteger(providerCooldownMs) || providerCooldownMs < 1000 || providerCooldownMs > 60 * 60_000) {
      throw new TypeError("[vitehub] Babysitter providerCooldownMs must be an integer from 1000 to 3600000.");
    }
    if (placement !== undefined && (!isRuntimeRecord(placement) || typeof placement.place !== "function" || (placement.remoteActive !== undefined && typeof placement.remoteActive !== "function"))) {
      throw new TypeError("[vitehub] Babysitter placement must be { place, remoteActive? } functions.");
    }
    if (placement?.admitted !== undefined && typeof placement.admitted !== "function") {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "placement.admitted", expected: "a function that returns the admitted slot count" });
    }
    if (!validBabysitterAdmission(admission)) {
      throw new TypeError("[vitehub] Babysitter admission must be { inputTokens: { hourly, daily }, minFreeTmpMb, paused, check } with non-negative integer token limits.");
    }
    if (!validAuthorAssociationRules(filter.authorAssociation)) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_OPTION_INVALID({ option: "filter.authorAssociation", expected: `{ allow, deny } lists of ${githubAuthorAssociations.join(", ")}` });
    }
    resolveBabysitterLifecycleFilter(filter, lifecycle);
    // Validate merge settings when the Agent is defined, not on the first PR.
    if (resolveBabysitterMerge(merge).mode !== "direct" && repairStackChildren) {
      throw presetsErrorDiagnostics.PRESETS_BABYSITTER_STACK_REPAIR_NEEDS_DIRECT_MERGE();
    }
    const definition = defineAgent({
      description: "Repair selected pull requests and wait for their checks and reviews.",
      // Signed GitHub deliveries feed the PR inbox. They never start the Agent directly.
      channels: { github: babysitterIntake },
      driver: (driver === "codex" ? codexDriver : claudeCodeDriver)({
        permissions: "allow-edits-unattended",
        instructions: {
          template: babysitterInstructions,
        },
        output: { schema: babysitterPassResultSchema },
      }),
    });
    return withAgentProcessHost(Object.assign(definition, { reviewChecks, noFindingsReviews, mentionAllowlist, ignoreFeedbackAuthors, noProgressBudget, reviewPushBudget, dailyPassBudget, deferWhilePending, install, lifecycle }), babysitterHost);
  },
});
