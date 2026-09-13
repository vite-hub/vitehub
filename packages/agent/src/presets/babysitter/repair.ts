import { defineCapability } from "../../capability-runtime.ts"
import type { GitHubPullRequestOperations } from "../../server/github.ts"

const noArguments = { type: "object", properties: {}, additionalProperties: false } as const

function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== "object" || !(key in input)) throw new Error(`Missing ${key}.`)
  const value = (input as Record<string, unknown>)[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`)
  return value
}

export function repairCapability(operations: GitHubPullRequestOperations, autoMerge: boolean) {
  return defineCapability({
    id: "babysitter.github",
    tools: {
      readCheckLogs: {
        name: "readCheckLogs",
        description: "Read failed logs for a GitHub Actions run associated with this PR head.",
        inputSchema: { type: "object", properties: { runId: { type: "integer", minimum: 1 } }, required: ["runId"], additionalProperties: false },
        execute: input => {
          if (!input || typeof input !== "object" || !("runId" in input) || typeof input.runId !== "number") throw new Error("Expected a run ID.")
          return operations.readCheckLogs(input.runId)
        },
      },
      pushRepair: {
        name: "pushRepair",
        description: "Push committed repairs to this PR's pinned source branch. Stop the pass after pushing.",
        inputSchema: noArguments,
        execute: async () => { await operations.push(); return { pushed: true } },
      },
      commentOnPullRequest: {
        name: "commentOnPullRequest",
        description: "Comment on this PR with a verified finding or external blocker.",
        inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
        execute: async input => { await operations.comment(stringField(input, "body")); return { commented: true } },
      },
      resolveReviewThread: {
        name: "resolveReviewThread",
        description: "Resolve an addressed review thread belonging to this PR.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        execute: async input => { await operations.resolveThread(stringField(input, "id")); return { resolved: true } },
      },
      updatePullRequest: {
        name: "updatePullRequest",
        description: "Update this PR's title or body while preserving unrelated content.",
        inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, additionalProperties: false },
        execute: async input => {
          if (!input || typeof input !== "object") throw new Error("Expected a title or body.")
          const title = "title" in input ? stringField(input, "title") : undefined
          const body = "body" in input ? stringField(input, "body") : undefined
          if (title === undefined && body === undefined) throw new Error("Expected a title or body.")
          await operations.updateMetadata({ title, body })
          return { updated: true }
        },
      },
      ...(autoMerge ? {
        requestAutoMerge: {
          name: "requestAutoMerge",
          description: "Request GitHub native auto-merge for the verified PR head. Repository checks and reviews remain required.",
          inputSchema: noArguments,
          execute: () => operations.requestAutoMerge(),
        },
      } : {}),
    },
  })
}

/** Provider authentication can pass through; GitHub authority stays on the host. */
export function repairEnvironment(environment: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(?:GH_|GITHUB_|GIT_)/i.test(key)))
  return { ...result, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
}
