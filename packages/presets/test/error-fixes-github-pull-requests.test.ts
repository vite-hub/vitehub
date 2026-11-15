import { expect, it } from "vitest"

import { presetsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createGitHubPullRequestOperations } from "../src/github/auto-merge.ts"
import { commitGitHubPullRequestWorkspace } from "../src/github/repair.ts"

const codes = [
  "PRESETS_AUTO_MERGE_HEAD_UNCONFIRMED",
  "PRESETS_AUTO_MERGE_REF_CHANGED",
  "PRESETS_AUTO_MERGE_UNCONFIRMED",
  "PRESETS_CHECKS_READ_INCOMPLETE",
  "PRESETS_COMMENT_MENTION_FORBIDDEN",
  "PRESETS_GITHUB_GRAPHQL_FAILED",
  "PRESETS_GITHUB_PAGINATION_INVALID",
  "PRESETS_GITHUB_QUERY_FAILED",
  "PRESETS_GITHUB_RESPONSE_INVALID",
  "PRESETS_MENTION_BODY_MENTION",
  "PRESETS_MENTION_LOGIN_NOT_ALLOWED",
  "PRESETS_OPERATION_BASE_CHANGED",
  "PRESETS_OPERATION_BASE_MISSING",
  "PRESETS_OPERATION_FILTER_MISMATCH",
  "PRESETS_OPERATION_HEAD_CHANGED",
  "PRESETS_OPERATION_PULL_REQUEST_CLOSED",
  "PRESETS_OPERATION_UNAVAILABLE",
  "PRESETS_PULL_REQUEST_BODY_CHANGED",
  "PRESETS_PULL_REQUEST_BODY_MENTION",
  "PRESETS_PULL_REQUEST_INPUT_EMPTY",
  "PRESETS_PULL_REQUEST_UPDATE_EMPTY",
  "PRESETS_REPAIR_CONFLICTS_UNRESOLVED",
  "PRESETS_REPAIR_INDEX_CHANGED",
  "PRESETS_REPAIR_INPUT_MISSING",
  "PRESETS_REPAIR_MERGE_CHANGED",
  "PRESETS_REPAIR_PATH_DIRECTORY",
  "PRESETS_REPAIR_PATH_INVALID",
  "PRESETS_REPAIR_STAGED_CHANGES",
  "PRESETS_REVIEW_THREAD_NOT_FOUND",
  "PRESETS_WORKFLOW_RUN_BASE_MISMATCH",
  "PRESETS_WORKFLOW_RUN_HEAD_MISMATCH",
  "PRESETS_WORKFLOW_RUN_ID_INVALID",
  "PRESETS_WORKSPACE_GIT_INVALID",
  "PRESETS_WORKSPACE_OVERLAPS_CHECKOUT",
] as const

/** Operations whose checks fail before any GitHub request. */
function operations(options: { mentionAllowlist?: string[], restrictCommentMentions?: boolean } = {}) {
  const github = { forge: async () => { throw new Error("The test makes no GitHub request.") } }
  return createGitHubPullRequestOperations(github, { repository: "acme/app", number: 12, expectedHeadOid: "a".repeat(40), ...options })
}

it("gives each GitHub pull request operation code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: Each code reads only the params that its `why` names; the loop checks the static fields.
    const error = (presetsErrorDiagnostics[code] as (params: { message: string }) => Error & { fix?: string, docs?: string })({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports a mention outside the allowlist with a code and a fix", async () => {
  await expect(operations({ mentionAllowlist: ["stefina"] }).mention("someone-else", "Please review.")).rejects.toMatchObject({
    code: "PRESETS_MENTION_LOGIN_NOT_ALLOWED",
    fix: expect.stringContaining("mentionAllowlist"),
    message: "GitHub login is not in the configured mention allowlist.",
  })
})

it("reports a comment with a mention with a code and a fix", async () => {
  await expect(operations({ restrictCommentMentions: true }).comment("Please ask @other-user.")).rejects.toMatchObject({
    code: "PRESETS_COMMENT_MENTION_FORBIDDEN",
    fix: expect.stringContaining("mentionOnPullRequest"),
  })
})

it("reports an invalid workflow run ID with a code and a fix", async () => {
  await expect(operations().readCheckLogs(0)).rejects.toMatchObject({
    code: "PRESETS_WORKFLOW_RUN_ID_INVALID",
    fix: expect.stringContaining("workflow run ID"),
  })
})

it("reports a repair path outside the checkout with a code and a fix", async () => {
  await expect(commitGitHubPullRequestWorkspace("/tmp", { message: "repair", paths: ["../outside.txt"] }, { expectedHead: "a".repeat(40) })).rejects.toMatchObject({
    code: "PRESETS_REPAIR_PATH_INVALID",
    fix: expect.stringContaining("relative to the checkout root"),
  })
})
