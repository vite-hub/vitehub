import { expect, it } from "vitest"

import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { enqueueChannelTask } from "../src/channel-tasks.ts"
import { channelAdapter, gmail, gmailClient } from "../src/channels.ts"

// The named codes that replace AGENT_R0930, AGENT_R0931, AGENT_R0940, AGENT_R0946, and AGENT_R1025.
const codes = [
  "AGENT_CHANNEL_HISTORY_INVALID",
  "AGENT_CHANNEL_HISTORY_MISSING",
  "AGENT_CHANNEL_HISTORY_TRIGGER_UNKNOWN",
  "AGENT_CHANNEL_MESSAGE_INVALID",
  "AGENT_CHANNEL_MESSAGE_METHOD_INVALID",
  "AGENT_CHANNEL_NOT_FOUND",
  "AGENT_CHANNEL_ON_ADAPTER_UNSUPPORTED",
  "AGENT_CHANNEL_ON_TRIGGER_NAME_TAKEN",
  "AGENT_CHANNEL_ON_WEBHOOK_TRIGGER",
  "AGENT_CHANNEL_STATE_QUEUE_UNSUPPORTED",
  "AGENT_CHANNEL_TASK_AGENT_AMBIGUOUS",
  "AGENT_CHANNEL_TASK_DELAY_INVALID",
  "AGENT_CHANNEL_TASK_KEY_INVALID",
  "AGENT_CHANNEL_TASK_NAME_MISSING",
  "AGENT_CHANNEL_TASK_NOT_BEFORE_INVALID",
  "AGENT_CHANNEL_TASK_QUEUE_MISSING",
  "AGENT_CHANNEL_TASK_START_CONFLICT",
  "AGENT_CHANNEL_TASK_TRIGGER_AMBIGUOUS",
  "AGENT_CHANNEL_TASK_UNDECLARED",
  "AGENT_CHANNEL_TRIGGER_UNKNOWN",
  "AGENT_CHANNEL_WEBHOOK_MISSING",
  "AGENT_DISPATCH_QUEUE_UNAVAILABLE",
  "AGENT_DISPATCH_TRIGGER_UNKNOWN",
  "AGENT_FORGE_ACTIVITY_FAILED",
  "AGENT_FORGE_ACTIVITY_TARGET_INVALID",
  "AGENT_FORGE_AGENT_IDENTITY_MISSING",
  "AGENT_FORGE_EFFECT_FAILED",
  "AGENT_FORGE_IDENTITY_UNRESOLVED",
  "AGENT_FORGE_LIFECYCLE_UPDATE_UNSUPPORTED",
  "AGENT_FORGE_METADATA_FAILED",
  "AGENT_FORGE_REVIEW_UNSUPPORTED",
  "AGENT_FORGE_WEBHOOK_SECRET_MISSING",
  "AGENT_GMAIL_AGENT_AMBIGUOUS",
  "AGENT_GMAIL_AGENT_MISSING",
  "AGENT_GMAIL_CHANNEL_EXPECTED",
  "AGENT_GMAIL_LABEL_MISSING",
  "AGENT_GMAIL_OPTIONS_INVALID",
  "AGENT_GMAIL_POLL_HOST_MISSING",
  "AGENT_INVOCATIONS_COMPACT_BUSY",
  "AGENT_INVOCATIONS_COMPACT_FILE_REQUIRED",
  "AGENT_INVOCATIONS_COMPACT_SPACE",
  "AGENT_INVOCATIONS_DATABASE_NOT_FILE",
  "AGENT_INVOCATIONS_DATABASE_URL_INVALID",
  "AGENT_INVOCATIONS_DURATION_INVALID",
  "AGENT_INVOCATIONS_JOURNAL_FAILED",
  "AGENT_INVOCATIONS_JOURNAL_MISSING",
  "AGENT_INVOCATIONS_JOURNAL_TABLE_MISSING",
  "AGENT_INVOCATIONS_NODE_SQLITE_MISSING",
  "AGENT_INVOCATIONS_PRUNE_CUTOFF_INVALID",
  "AGENT_INVOCATIONS_SIZE_INVALID",
  "AGENT_INVOCATIONS_TABLE_PREFIX_INVALID",
  "AGENT_INVOCATION_NOT_FOUND",
] as const

const params = {
  action: "queue tasks", agents: "a, b", busyTimeoutMs: 1, channel: "c", channelId: "c", detail: "d", flag: "--max-size", id: "i", kind: "gitlab",
  label: "l", liveBytes: 1, location: "l", message: "m", method: "enqueueChannelTask", name: "n", option: "message", status: 500,
  table: "t", target: "task", task: "t", trigger: "t", triggers: "t", volumes: ["v"],
} as const

it("gives each code its own fix and docs page", () => {
  for (const code of codes) {
    // SAFETY: each code reads only the params it declares from this shared object.
    const error = (agentDiagnostics[code] as (input: typeof params) => Error & { fix?: string, docs?: string })(params)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("keeps the message of the call site", () => {
  expect(agentDiagnostics.AGENT_FORGE_WEBHOOK_SECRET_MISSING({ kind: "gitlab" }).message).toBe("[vitehub] gitlab() requires webhookSecret or GITLAB_WEBHOOK_SECRET.")
  expect(agentDiagnostics.AGENT_INVOCATIONS_JOURNAL_MISSING({ location: "/j.db" }).message).toBe("No Agent Invocation journal exists at /j.db.")
  expect(agentDiagnostics.AGENT_INVOCATIONS_COMPACT_FILE_REQUIRED({}).message).toContain("An in-memory database has no file to compact.")
})

it("puts the fix on a bad channelAdapter() message option", () => {
  expect(() => channelAdapter("raw", { message: "text" as never })).toThrow(expect.objectContaining({
    code: "AGENT_CHANNEL_MESSAGE_INVALID",
    fix: expect.stringContaining("channelAdapter(kind, { message })"),
  }))
})

it("puts the fix on a bad gmail() option and keeps its input-error status", () => {
  let caught: unknown
  try { gmail({ bodyLimit: 0 }) }
  catch (error) { caught = error }
  expect(caught).toMatchObject({ code: "AGENT_GMAIL_OPTIONS_INVALID", message: "[vitehub] gmail() bodyLimit must be a positive integer.", fix: expect.stringContaining("gmail()") })
  expect(isAgentTypeDiagnostic(caught)).toBe(true)
})

it("puts the fix on a Gmail helper that gets another Channel", async () => {
  await expect(gmailClient(channelAdapter("raw"))).rejects.toMatchObject({
    code: "AGENT_GMAIL_CHANNEL_EXPECTED",
    fix: expect.stringContaining("gmail()"),
  })
})

it("returns the Agent code with its fix as the cause of a rejected Channel task", async () => {
  const [error] = await enqueueChannelTask("airtable", "sync", { prompt: "p" }, { delayMs: 1, notBefore: 1 })
  expect(error).toMatchObject({
    code: "CHANNEL_TASK_REJECTED",
    why: "enqueueChannelTask() takes notBefore or delayMs, not both.",
    cause: { code: "AGENT_CHANNEL_TASK_START_CONFLICT", fix: expect.stringContaining("`notBefore` or `delayMs`") },
  })
})
