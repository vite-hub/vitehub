import type { AgentInvocationContextStore } from "../../types.ts";
import { defineCapability } from "../../capability-runtime.ts";
import type { GitHubPullRequestOperations } from "../../server/github.ts";
import { isRuntimeRecord, hasRuntimeType } from "../../internal/runtime-type.ts";
import { normalizeGitHubMentionAllowlist } from "../../server/github-auto-merge.ts";

const noArguments = { type: "object", properties: {}, additionalProperties: false } as const;

function stringField(input: unknown, key: string, allowEmpty = false): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability inputs are untyped until this runtime boundary validates them.
  if (!input || typeof input !== "object" || !(key in input)) throw new Error(`Missing ${key}.`);
  // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- The preceding object guard establishes a record-shaped capability input.
  const value = (input as Record<string, unknown>)[key];
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability inputs are untyped until this runtime boundary validates them.
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  return value;
}

export function repairCapability(operations: GitHubPullRequestOperations, autoMerge: boolean, mentionAllowlist: readonly string[] = [], beforePush?: (context: AgentInvocationContextStore) => Promise<void>, workspace?: {
  beforeRepair(context: AgentInvocationContextStore, paths?: readonly string[]): Promise<void>;
  afterRefresh(context: AgentInvocationContextStore): Promise<void>;
  runRepair?<T>(execute: () => Promise<T>): Promise<T>;
}) {
  const withinRepair = <T>(execute: () => Promise<T>) => workspace?.runRepair ? workspace.runRepair(execute) : execute();
  const allowedMentions = normalizeGitHubMentionAllowlist(mentionAllowlist)
  return defineCapability({
    id: "babysitter.github",
    tools: context => ({
      readCheckLogs: {
        name: "readCheckLogs",
        description: "Read failed logs for a GitHub Actions run associated with this PR head.",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "integer", minimum: 1 } },
          required: ["runId"],
          additionalProperties: false,
        },
        execute: (input: unknown) => {
          if (
            !input ||
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability inputs are untyped until this runtime boundary validates them.
            typeof input !== "object" ||
            !("runId" in input) ||
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability input is validated at runtime.
            typeof input.runId !== "number"
          )
            throw new Error("Expected a run ID.");
          return operations.readCheckLogs(input.runId);
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
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability input is untyped until this runtime boundary validates it.
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
          await operations.push();
          return { pushed: true };
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
      // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- The mention tool is intentionally absent until the application configures recipients.
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
        description: "Resolve an addressed review thread belonging to this PR.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          await operations.resolveThread(stringField(input, "id"));
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
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate untyped capability input at the runtime boundary.
          if (!input || typeof input !== "object") throw new Error("Expected a title or body.");
          const title = "title" in input ? stringField(input, "title") : undefined;
          const body = "body" in input ? stringField(input, "body", true) : undefined;
          if (title === undefined && body === undefined)
            throw new Error("Expected a title or body.");
          await operations.updateMetadata({ title, body });
          return { updated: true };
        },
      },
          // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional capability is intentionally omitted when disabled.
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
