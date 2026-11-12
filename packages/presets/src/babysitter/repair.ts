import type { AgentInvocationContextStore } from "@vite-hub/agent";
import { defineCapability } from "@vite-hub/agent";
import { presetsErrorDiagnostics } from "../error-diagnostics.ts";
import type { GitHubPullRequestOperations } from "../github/index.ts";
import { isRuntimeRecord, hasRuntimeType } from "../internal/runtime-type.ts";
import { isReviewThreadOutcome, normalizeGitHubMentionAllowlist, reviewThreadOutcomes } from "../github/index.ts";

const noArguments = { type: "object", properties: {}, additionalProperties: false } as const;

function stringField(input: unknown, key: string, allowEmpty = false): string {
  if (!input || typeof input !== "object" || !(key in input)) throw new Error(`Missing ${key}.`);
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  return value;
}

export function repairCapability(operations: GitHubPullRequestOperations, autoMerge: boolean, mentionAllowlist: readonly string[] = [], beforePush?: (context: AgentInvocationContextStore) => Promise<void>, workspace?: {
  beforeRepair(context: AgentInvocationContextStore, paths?: readonly string[]): Promise<void>;
  afterRefresh(context: AgentInvocationContextStore): Promise<void>;
  runRepair?<T>(execute: () => Promise<T>): Promise<T>;
  readState?(): Promise<unknown>;
  readFeedback?(input: unknown): Promise<unknown>;
}) {
  const withinRepair = <T>(execute: () => Promise<T>) => workspace?.runRepair ? workspace.runRepair(execute) : execute();
  const readState = workspace?.readState;
  const readFeedback = workspace?.readFeedback;
  const allowedMentions = normalizeGitHubMentionAllowlist(mentionAllowlist)
  return defineCapability({
    id: "babysitter.github",
    tools: context => ({
      ...(readState ? { readRepairState: {
        name: "readRepairState",
        description: "Read the assigned PR head/base, verified publication, installation result and current claim from the host. This reads local state, not GitHub polling.",
        inputSchema: noArguments,
        execute: () => readState(),
      } } : {}),
      ...(readFeedback ? { readFeedback: {
        name: "readFeedback",
        description: "Read a full review or comment body from this PR's durable snapshot in bounded pages. Continue using next.offset and next.version; changed feedback requires reading from offset zero.",
        inputSchema: {
          type: "object",
          properties: { kind: { type: "string", enum: ["comment", "review", "review-comment"] }, id: { type: "string", minLength: 1, maxLength: 256 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 }, version: { type: "string", pattern: "^[a-f0-9]{64}$" } },
          required: ["kind", "id"], additionalProperties: false,
        },
        execute: (input: unknown) => readFeedback(input),
      } } : {}),
      readCheckLogs: {
        name: "readCheckLogs",
        description: "Read failed logs for a GitHub Actions run associated with this PR head. Logs are stripped of color codes and branch listings. Without a range the result is a failure-focused excerpt; use tailLines for the end of the log or startLine/endLine for up to 1000 complete lines it omitted. Line numbers count this tool's log, not the preloaded ciEvidence.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "integer", minimum: 1 },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
            tailLines: { type: "integer", minimum: 1, maximum: 1000 },
          },
          required: ["runId"],
          additionalProperties: false,
        },
        execute: (input: unknown) => {
          if (
            !input ||
            typeof input !== "object" ||
            !("runId" in input) ||
            typeof input.runId !== "number"
          )
            throw new Error("Expected a run ID.");
          const { runId, ...selection } = input;
          return operations.readCheckLogs(runId, selection);
        },
      },
      readBaseCheckEvidence: {
        name: "readBaseCheckEvidence",
        description: "Read bounded checks, statuses and workflow runs for this PR's exact assigned base commit. Use it to compare a suspected base regression without GitHub shell credentials.",
        inputSchema: noArguments,
        execute: () => operations.readBaseCheckEvidence(),
      },
      readBaseCheckLogs: {
        name: "readBaseCheckLogs",
        description: "Read bounded failed logs for a workflow run on this PR's exact assigned base commit. A synthetic merge run is not base evidence.",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "integer", minimum: 1 } },
          required: ["runId"],
          additionalProperties: false,
        },
        execute: (input: unknown) => {
          if (!input || typeof input !== "object" || !("runId" in input) || typeof input.runId !== "number") throw new Error("Expected a run ID.");
          return operations.readBaseCheckLogs(input.runId);
        },
      },
      refreshDependencies: {
        name: "refreshDependencies",
        description: "Install frozen dependencies after resolving dependency conflicts or changing manifests or lockfiles. Run before validation.",
        inputSchema: noArguments,
        execute: () => withinRepair(async () => { await workspace?.beforeRepair(context.context); await operations.refreshDependencies(); await workspace?.afterRefresh(context.context); return { refreshed: true }; }),
      },
      commitRepair: {
        name: "commitRepair",
        description: "Stage the named repair files and commit them on the host. Git metadata is read-only in the provider sandbox. Call pushRepair after validation and this commit.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", minLength: 1 }, paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
          required: ["message", "paths"],
          additionalProperties: false,
        },
        execute: (input: unknown) => withinRepair(async () => {
          if (!isRuntimeRecord(input) || !Array.isArray(input.paths) || !input.paths.every(path => hasRuntimeType(path, "string"))) throw new Error("Expected explicit repair paths.");
          await workspace?.beforeRepair(context.context, input.paths);
          const head = await operations.commitRepair({ message: stringField(input, "message"), paths: input.paths });
          return { head };
        }),
      },
      pushRepair: {
        name: "pushRepair",
        description:
          "Push committed repairs to this PR's pinned source branch. After pushing, resolve any review threads fixed by the push before ending the pass.",
        inputSchema: noArguments,
        execute: () => withinRepair(async () => {
          await beforePush?.(context.context);
          const head = await operations.push();
          return { pushed: true, head };
        }),
      },
      commentOnPullRequest: {
        name: "commentOnPullRequest",
        description: "Comment on this PR with a verified finding or external blocker.",
        inputSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          await operations.comment(stringField(input, "body"));
          return { commented: true };
        },
      },
      ...(allowedMentions.length ? {
        mentionOnPullRequest: {
          name: "mentionOnPullRequest",
          description: `Mention one configured human (${allowedMentions.map(login => `@${login}`).join(", ")}) about a verified blocker that needs their action. This sends a notification; use it sparingly.`,
          inputSchema: {
            type: "object",
            properties: { login: { type: "string", enum: allowedMentions }, body: { type: "string" } },
            required: ["login", "body"],
            additionalProperties: false,
          },
          execute: async (input: unknown) => {
            await operations.mention(stringField(input, "login"), stringField(input, "body"));
            return { mentioned: true };
          },
        },
      } : {}),
      resolveReviewThread: {
        name: "resolveReviewThread",
        description: "Answer and resolve a review thread belonging to this PR. The outcome and reason are posted as a reply on the thread before it is resolved: fixed (the current code fixes it; reason optional, name the commit), disproved (the finding is wrong for the current code), declined (valid, but out of this PR's scope or below the severity bar; name the class, for example P2), pre-existing (the PR did not introduce it) or duplicate (already answered in another thread). Every outcome other than fixed needs a one-sentence reason.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            outcome: { type: "string", enum: Object.keys(reviewThreadOutcomes) },
            reason: { type: "string" },
          },
          required: ["id", "outcome"],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          const outcome = stringField(input, "outcome");
          if (!isReviewThreadOutcome(outcome)) throw presetsErrorDiagnostics.PRESETS_REVIEW_OUTCOME_INVALID();
          const reason = isRuntimeRecord(input) && "reason" in input ? stringField(input, "reason", true) : undefined;
          await operations.resolveThread(stringField(input, "id"), { outcome, reason });
          return { resolved: true };
        },
      },
      updatePullRequest: {
        name: "updatePullRequest",
        description: "Update this PR's title or body while preserving unrelated content.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          if (!input || typeof input !== "object") throw new Error("Expected a title or body.");
          const title = "title" in input ? stringField(input, "title") : undefined;
          const body = "body" in input ? stringField(input, "body", true) : undefined;
          if (title === undefined && body === undefined)
            throw new Error("Expected a title or body.");
          await operations.updateMetadata({ title, body });
          return { updated: true };
        },
      },
          ...(autoMerge
        ? {
            requestAutoMerge: {
              name: "requestAutoMerge",
              description:
                "Request GitHub native auto-merge for the verified PR head. Repository checks and reviews remain required.",
              inputSchema: noArguments,
              execute: () => operations.requestAutoMerge(),
            },
          }
        : {}),
    }),
  });
}

/** Provider authentication can pass through; GitHub authority stays on the host. */
export function repairEnvironment(
  environment: Record<string, string | undefined> = {},
  githubConfigDirectory: string,
  identity: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const result = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !/^(?:GH_|GITHUB_|GIT_)/i.test(key)),
  );
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    const value = identity[key] ?? environment[key];
    if (value !== undefined) result[key] = value;
  }
  return {
    ...result,
    GH_CONFIG_DIR: githubConfigDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
