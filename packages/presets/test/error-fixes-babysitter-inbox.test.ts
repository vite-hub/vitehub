import { defineAgent } from "@vite-hub/agent"
import { expect, it } from "vitest"

import { babysitter } from "../src/babysitter.ts"
import { readBabysitterFeedback } from "../src/babysitter/feedback.ts"
import { assertPromptFits } from "../src/babysitter/inbox/snapshot-prompt.ts"
import { PullRequestInbox } from "../src/babysitter/inbox/store.ts"
import { presetsErrorDiagnostics } from "../src/error-diagnostics.ts"

const codes = [
  "PRESETS_BABYSITTER_ADMISSION_CHECK_INVALID",
  "PRESETS_BABYSITTER_CHECKOUT_POOL_REPLACED",
  "PRESETS_BABYSITTER_CHECKOUT_POOL_UNSAFE",
  "PRESETS_BABYSITTER_GITHUB_CURSOR_INVALID",
  "PRESETS_BABYSITTER_GITHUB_HEAD_MISSING",
  "PRESETS_BABYSITTER_GITHUB_QUERY_FAILED",
  "PRESETS_BABYSITTER_HOST_EXECUTABLE_UNAVAILABLE",
  "PRESETS_BABYSITTER_INBOX_STORAGE_MISSING",
  "PRESETS_BABYSITTER_PROMPT_TOO_LARGE",
  "PRESETS_DEPENDENCY_CHECKS_INCOMPLETE",
  "PRESETS_FEEDBACK_CHANGED",
  "PRESETS_FEEDBACK_NOT_FOUND",
  "PRESETS_FEEDBACK_OFFSET_INVALID",
  "PRESETS_FEEDBACK_VERSION_MISSING",
  "PRESETS_SANDBOX_BUNDLE_MISSING",
  "PRESETS_SANDBOX_COMMIT_EXPORT_FAILED",
  "PRESETS_SANDBOX_COMMIT_MISSING",
  "PRESETS_SANDBOX_HEAD_CHANGED",
  "PRESETS_SANDBOX_REPAIR_DESTINATION_CHANGED",
  "PRESETS_SANDBOX_REPAIR_DESTINATION_OUTSIDE",
  "PRESETS_SANDBOX_REPAIR_FILE_MISSING",
  "PRESETS_SANDBOX_REPAIR_PARENT_INVALID",
  "PRESETS_SANDBOX_REPAIR_PATH_DIRECTORY",
  "PRESETS_SANDBOX_REPAIR_PATH_INVALID",
  "PRESETS_SANDBOX_SYNC_FAILED",
] as const

it("gives each Babysitter pass and inbox code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: Each code reads only the params that its `why` names; the loop checks the static fields.
    const error = (presetsErrorDiagnostics[code] as (params: { message: string }) => Error & { fix?: string, docs?: string })({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports feedback that is not in the pull request with a code and a fix", () => {
  // SAFETY: readBabysitterFeedback() reads only the feedback collections of the snapshot.
  const snapshot = { comments: {}, reviews: {}, reviewComments: {}, threads: [] } as never
  expect(() => readBabysitterFeedback(snapshot, { kind: "comment", id: "IC_missing" })).toThrow(expect.objectContaining({
    code: "PRESETS_FEEDBACK_NOT_FOUND",
    fix: expect.stringContaining("readFeedback"),
    message: "Feedback is absent or deleted from the assigned PR snapshot.",
  }))
})

it("reports a prompt over the transport limit with a code and a fix", () => {
  expect(() => assertPromptFits("x".repeat(20), 10)).toThrow(expect.objectContaining({
    code: "PRESETS_BABYSITTER_PROMPT_TOO_LARGE",
    fix: expect.stringContaining("pull request"),
  }))
})

it("reports an inbox without storage with a code and a fix", () => {
  expect(() => new PullRequestInbox({ repositories: () => ["acme/app"] })).toThrow(expect.objectContaining({
    code: "PRESETS_BABYSITTER_INBOX_STORAGE_MISSING",
    fix: expect.stringContaining("inboxPath"),
  }))
})

it("reports an invalid merge method with a code and a fix", () => {
  expect(() => defineAgent({ extends: babysitter, options: { merge: { strategy: "direct", method: "fast-forward" as never } } })).toThrow(expect.objectContaining({
    code: "PRESETS_BABYSITTER_OPTION_INVALID",
    fix: expect.stringContaining("merge.method"),
  }))
})
