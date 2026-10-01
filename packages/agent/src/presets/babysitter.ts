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

export type { BabysitterMerge, BabysitterMergeMethod, BabysitterMergeReadinessInput, BabysitterMergeReady } from "./babysitter/merge.ts";

export interface BabysitterOptions {
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
  /** @deprecated Use `merge: "auto"`. */
  autoMerge: boolean;
}

export interface BabysitterPassResult {
  disposition: "park" | "retry";
  text: string;
}

export const babysitterPassResultSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "vitehub.babysitter",
    validate(
      value: unknown,
    ): { value: BabysitterPassResult } | { issues: Array<{ message: string }> } {
      if (
        value &&
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Babysitter result validation narrows untyped external output.
        typeof value === "object" &&
        "disposition" in value &&
        "text" in value &&
        (value.disposition === "park" || value.disposition === "retry") &&
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Result text is validated at runtime.
        typeof value.text === "string" &&
        value.text.trim()
      ) {
        return {
          value: {
            disposition: value.disposition,
            text: value.text,
          } satisfies BabysitterPassResult,
        };
      }
      return {
        issues: [{ message: "Expected a park/retry disposition and a non-empty text result." }],
      };
    },
  },
};

/** A repair workflow. Connections, provider settings and host resources stay in the application. */
type BabysitterDefinition = AgentDefinition<
  AgentRuntimeConfig,
  unknown,
  AgentInvokerProfile,
  AgentInvocationContextValues,
  BabysitterPassResult
> & { reviewChecks: string[] };

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
    autoMerge: false,
  },
  configure: ({ filter, driver, merge, reviewChecks, autoMerge }) => {
    if (driver !== "codex" && driver !== "claude-code") {
      throw new TypeError('[vitehub] Babysitter driver must be "codex" or "claude-code".');
    }
    // Validate merge settings when the Agent is defined, not on the first PR.
    resolveBabysitterMerge(merge, autoMerge);
    const definition = defineAgent({
      description: "Repair selected pull requests and wait for their checks and reviews.",
      channels: { github: { pullRequest: { filter } } },
      driver: {
        kind: driver,
        permissions: "allow-edits",
        instructions: {
          template: babysitterInstructions,
        },
        output: { schema: babysitterPassResultSchema },
      },
    });
    // Keep preset-only policy on the configured definition so runtime hosts
    // can read it alongside the other Babysitter options.
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- Object.assign preserves the configured AgentDefinition and adds the preset-owned reviewChecks policy.
    return Object.assign(definition, { reviewChecks }) as BabysitterDefinition;
  },
});
