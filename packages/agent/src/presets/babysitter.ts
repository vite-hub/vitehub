import { defineAgent } from "../index.ts";
import type {
  ConfiguredAgentDefinition,
  AgentDefinition,
  AgentRuntimeConfig,
  AgentInvokerProfile,
  AgentInvocationContextValues,
} from "../index.ts";
import type { GitHubPullRequestFilter } from "../channels.ts";
import type { BuiltInAgentDriverName } from "../types.ts";
import { babysitterInstructions } from "./babysitter/instructions.ts";
import { resolveBabysitterMerge, type BabysitterMerge } from "./babysitter/merge.ts";
import { validBabysitterAdmission, type BabysitterAdmissionOptions } from "./babysitter/admission.ts";
import { defineChannel, defineChannelTrigger } from "../channels.ts";
import { channelEnvValue } from "../channel-env.ts";
import { agentProcessHostIntake, withAgentProcessHost, type AgentProcessHostContribution } from "../agent-process-host.ts";
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts";

export type { BabysitterMerge, BabysitterMergeMethod, BabysitterMergeReadinessInput, BabysitterMergeReady } from "./babysitter/merge.ts";
export type { BabysitterAdmissionOptions, BabysitterAdmissionPause } from "./babysitter/admission.ts";

export interface BabysitterOptions {
  /** Process admission policy. Concurrency remains the preset hard maximum. */
  capacity?: Pick<import("../runtime/process.ts").ProcessAgentCapacityOptions, "memory" | "cpu" | "fallbackConcurrency">;
  /** Select PRs with the same rules as the GitHub Channel. */
  filter: GitHubPullRequestFilter;
  /** Provider Driver that repairs each PR in its checkout. Defaults to `"codex"`. Set the model with `driver.model`. */
  driver: BuiltInAgentDriverName;
  /**
   * Merge policy. Defaults to `false`. `"auto"` lets the worker request GitHub native auto-merge.
   * `"direct"` merges a ready PR into its default branch before any model pass.
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
   * Wait for running required checks and review checks before a pass, unless a failure or conflict
   * already needs repair. One pass then handles CI and review results together. Defaults to `true`.
   */
  deferWhilePending: boolean;
  /**
   * Install dependencies on the host before the provider starts. `true` detects pnpm, npm or
   * Yarn from the lockfile and installs it frozen. A command overrides the detection. A detected pnpm
   * install reuses the trees of earlier passes. Defaults to `true`.
   */
  install: BabysitterInstall;
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
  /** @deprecated Use `merge: "auto"`. */
  autoMerge: boolean;
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
   * `<tmpdir>/vitehub-install-cache` and must share a filesystem with the pass workspaces.
   * `entries` defaults to `BABYSITTER_INSTALL_CACHE_ENTRIES` or 8. `false` disables the cache.
   */
  cache?: false | { directory?: string; entries?: number };
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
}

const babysitterSha = /^[a-f0-9]{40,64}$/;
const validSha = (value: unknown): value is string => hasRuntimeType(value, "string") && babysitterSha.test(value);

function parseWake(value: unknown): BabysitterPassWake | undefined {
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.kind, "string") || !hasRuntimeType(value.repository, "string")) return undefined;
  if (value.kind === "checks" && validSha(value.headSha)) return { kind: "checks", repository: value.repository, headSha: value.headSha };
  if (value.kind === "pull-request" && hasRuntimeType(value.number, "number") && Number.isSafeInteger(value.number) && value.number > 0) return { kind: "pull-request", repository: value.repository, number: value.number };
  return undefined;
}

function parseWait(value: unknown): BabysitterPassWait | undefined {
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.kind, "string")) return undefined;
  if (value.kind === "checks" && validSha(value.headSha)) return { kind: "checks", headSha: value.headSha };
  if (value.kind === "external" && hasRuntimeType(value.reason, "string") && value.reason.trim()) {
    const wake = parseWake(value.wake);
    const wait = { kind: "external" as const, reason: value.reason.trim() };
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional wake metadata is omitted when no dependency can unblock the wait.
    if (wake) Object.assign(wait, { wake });
    return wait;
  }
  return undefined;
}

/**
 * Provider output is an untrusted boundary. Keep the required disposition, but
 * normalize optional coordination fields so an invalid wait hint cannot discard
 * an otherwise useful park/retry result (older models frequently omit `kind`).
 */
export const babysitterPassResultSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "vitehub.babysitter",
    validate(value: unknown): { value: BabysitterPassResult } | { issues: Array<{ message: string }> } {
      if (!isRuntimeRecord(value) || (value.disposition !== "park" && value.disposition !== "retry")) {
        return { issues: [{ message: "Expected a park/retry disposition." }] };
      }
      const text = hasRuntimeType(value.text, "string") && value.text.trim() ? value.text.trim() : "Babysitter pass completed.";
      const wait = parseWait(value.wait);
      const reviewedHead = validSha(value.reviewedHead) ? value.reviewedHead : undefined;
      const waitForChecksHead = validSha(value.waitForChecksHead) ? value.waitForChecksHead : undefined;
      const normalized: BabysitterPassResult = { disposition: value.disposition, text };
      // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional provider metadata is omitted when invalid or absent.
      if (wait) normalized.wait = wait;
      if (reviewedHead) normalized.reviewedHead = reviewedHead;
      if (waitForChecksHead) normalized.waitForChecksHead = waitForChecksHead;
      return { value: normalized };
    },
  },
};

function validInstall(install: unknown): boolean {
  if (hasRuntimeType(install, "boolean")) return true;
  if (!isRuntimeRecord(install)) return false;
  const { command, args, cache } = install;
  if (command !== undefined && !(hasRuntimeType(command, "string") && command.trim())) return false;
  if (args !== undefined && (command === undefined || !Array.isArray(args) || !args.every(arg => hasRuntimeType(arg, "string")))) return false;
  if (cache === undefined || cache === false) return true;
  if (!isRuntimeRecord(cache)) return false;
  return (cache.directory === undefined || (hasRuntimeType(cache.directory, "string") && cache.directory.trim() !== ""))
    && (cache.entries === undefined || (Number.isSafeInteger(cache.entries) && Number(cache.entries) >= 1));
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

const babysitterIntake = defineChannel("babysitter-github", {
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
          if (!secret) throw new Error("[vitehub] The Babysitter webhook needs GITHUB_WEBHOOK_SECRET.");
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
  AgentInvokerProfile,
  AgentInvocationContextValues,
  BabysitterPassResult
> & {
  reviewChecks: string[];
  noFindingsReviews: string[];
  ignoreFeedbackAuthors: string[];
  noProgressBudget: number | false;
  deferWhilePending: boolean;
  install: BabysitterInstall;
  mentionAllowlist: string[];
};

export type BabysitterAgent = ConfiguredAgentDefinition<BabysitterOptions, BabysitterDefinition>;

export const babysitter: BabysitterAgent = defineAgent({
  options: {
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default filter is constrained by BabysitterOptions at the public preset boundary.
    filter: {} as GitHubPullRequestFilter,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default widens to the documented driver union.
    driver: "codex" as BuiltInAgentDriverName,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default widens to the documented merge union.
    merge: false as BabysitterMerge,
    reviewChecks: [] as string[],
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The empty default widens to the documented prefix list.
    noFindingsReviews: [] as string[],
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The empty default widens to the documented login list.
    ignoreFeedbackAuthors: [] as string[],
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default widens to the documented budget union.
    noProgressBudget: 3 as number | false,
    deferWhilePending: true,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The default widens to the documented install union.
    install: true as BabysitterInstall,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The empty default widens to the documented login allowlist.
    mentionAllowlist: [] as string[],
    concurrency: 1,
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The empty default widens to the documented admission options.
    admission: {} as BabysitterAdmissionOptions,
    autoMerge: false,
  },
  configure: ({ driver, merge, reviewChecks, noFindingsReviews, mentionAllowlist, ignoreFeedbackAuthors, noProgressBudget, deferWhilePending, install, autoMerge, concurrency, admission }) => {
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
    if (!hasRuntimeType(deferWhilePending, "boolean")) {
      throw new TypeError("[vitehub] Babysitter deferWhilePending must be a boolean.");
    }
    if (!validInstall(install)) {
      throw new TypeError("[vitehub] Babysitter install must be a boolean or { command, args, cache }.");
    }
    if (!validBabysitterAdmission(admission)) {
      throw new TypeError("[vitehub] Babysitter admission must be { inputTokens: { hourly, daily }, minFreeTmpMb, paused, check } with non-negative integer token limits.");
    }
    // Validate merge settings when the Agent is defined, not on the first PR.
    resolveBabysitterMerge(merge, autoMerge);
    const definition = defineAgent({
      description: "Repair selected pull requests and wait for their checks and reviews.",
      // Signed GitHub deliveries feed the PR inbox. They never start the Agent directly.
      channels: { github: babysitterIntake },
      driver: {
        kind: driver,
        permissions: "allow-edits-unattended",
        instructions: {
          template: babysitterInstructions,
        },
        output: { schema: babysitterPassResultSchema },
      },
    });
    return withAgentProcessHost(Object.assign(definition, { reviewChecks, noFindingsReviews, mentionAllowlist, ignoreFeedbackAuthors, noProgressBudget, deferWhilePending, install }), babysitterHost);
  },
});
