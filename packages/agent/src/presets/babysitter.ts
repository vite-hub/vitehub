import { defineAgent } from "../index.ts";
import type {
  ConfiguredAgentDefinition,
  AgentDefinition,
  AgentRuntimeConfig,
  AgentInvokerProfile,
  AgentInvocationContextValues,
} from "../index.ts";
import type { GitHubPullRequestFilter } from "../channels.ts";
import { babysitterInstructions } from "./babysitter/instructions.ts";

export interface BabysitterOptions {
  /** Select PRs with the same rules as the GitHub Channel. */
  filter: GitHubPullRequestFilter;
  /** Permit the host to request GitHub native auto-merge. Disabled by default. */
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
        typeof value === "object" &&
        "disposition" in value &&
        "text" in value &&
        (value.disposition === "park" || value.disposition === "retry") &&
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
export type BabysitterAgent = ConfiguredAgentDefinition<
  BabysitterOptions,
  AgentDefinition<
    AgentRuntimeConfig,
    unknown,
    AgentInvokerProfile,
    AgentInvocationContextValues,
    BabysitterPassResult
  >
>;

export const babysitter: BabysitterAgent = defineAgent({
  options: { filter: {} as GitHubPullRequestFilter, autoMerge: false },
  configure: ({ filter }) =>
    defineAgent({
      description: "Repair selected pull requests and wait for their checks and reviews.",
      channels: { github: { pullRequest: { filter } } },
      driver: {
        kind: "codex",
        permissions: "allow-edits",
        instructions: {
          template: babysitterInstructions,
        },
        output: { schema: babysitterPassResultSchema },
      },
    }),
});
