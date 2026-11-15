import { expect, it } from "vitest"

import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { channelDelivery } from "../src/capabilities/index.ts"
import { pullAgentChannel, runChannelStateTransaction } from "../src/internal/channel-state.ts"

const codes = [
  "AGENT_CHANNEL_DELIVERY_CHANNEL_INVALID",
  "AGENT_CHANNEL_DELIVERY_FORMAT_EMPTY",
  "AGENT_CHANNEL_DELIVERY_MAX_CALLS_INVALID",
  "AGENT_CHANNEL_DELIVERY_REMINDER_INSTRUCTION_INVALID",
  "AGENT_CHANNEL_DELIVERY_REMINDER_NOT_REQUIRED",
  "AGENT_CHANNEL_DELIVERY_REMINDER_TURNS_INVALID",
  "AGENT_CHANNEL_MESSAGE_ID_MISSING",
  "AGENT_CHANNEL_PULL_CURSOR_INVALID",
  "AGENT_CHANNEL_PULL_CURSOR_TYPE_CHANGED",
  "AGENT_CHANNEL_PULL_OPTIONS_INVALID",
  "AGENT_CHANNEL_PULL_PAGE_INVALID",
  "AGENT_CHANNEL_PULL_STATE_MISSING",
  "AGENT_CHANNEL_STATE_DURATION_INVALID",
  "AGENT_CHANNEL_STATE_LOCK_BUSY",
  "AGENT_CHANNEL_STATE_QUEUE_MISSING",
  "AGENT_CHANNEL_STATE_TRANSACTION_INVALID",
  "AGENT_CHANNEL_STATE_TRANSACTION_NESTED",
  "AGENT_CONNECTOR_ADAPTER_UNSUPPORTED",
  "AGENT_CONNECTOR_RECIPIENT_INVALID",
  "AGENT_CONNECTOR_RECIPIENT_MISSING",
  "AGENT_CONNECTOR_REPLACE_INVALID",
  "AGENT_CONNECTOR_REPLACE_THREAD_ROOT",
  "AGENT_CONNECTOR_THREAD_KEY_MISSING",
  "AGENT_CONNECTOR_THREAD_RECIPIENT_INVALID",
  "AGENT_CONNECTOR_THREAD_UNSUPPORTED",
  "AGENT_GITHUB_ACTIVITY_AGENT_MISSING",
  "AGENT_GMAIL_DISPATCH_FAILED",
  "AGENT_GMAIL_LOCK_LOST",
  "AGENT_GMAIL_MAILBOX_MISMATCH",
  "AGENT_GMAIL_SYNC_BUSY",
  "AGENT_SLACK_CONNECTOR_ADAPTER_MISSING",
] as const

const params = { action: "delete messages", allowZero: false, count: 1, cursor: 1, cursorType: "number", key: "k", kind: "gap", label: "Slack", lock: "mailbox", name: "ttlMs", need: "a callback", next: 2, root: true, triggerId: "t", waitMs: 1 } as const

it("gives each Channel code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: each code reads only the params it declares from this shared object.
    const error = (agentDiagnostics[code] as (input: typeof params) => Error & { fix?: string, docs?: string })(params)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

const channel = { name: "teams", send: async () => ({ id: "m" }) }

it("reports channelDelivery({ maxCalls: 0 }) with a code and a fix", () => {
  const error = (() => {
    try { channelDelivery({ channel, maxCalls: 0 } as never) }
    catch (caught) { return caught }
  })()
  expect(error).toMatchObject({
    code: "AGENT_CHANNEL_DELIVERY_MAX_CALLS_INVALID",
    message: "[vitehub] channelDelivery({ maxCalls }) must be a positive integer.",
    fix: expect.stringContaining("channelDelivery({ maxCalls })"),
  })
  // An option error keeps the input-error status that the TypeError had.
  expect(isAgentTypeDiagnostic(error)).toBe(true)
})

it("reports a reminder without required: true with a code and a fix", () => {
  expect(() => channelDelivery({ channel, reminder: true } as never)).toThrow(expect.objectContaining({
    code: "AGENT_CHANNEL_DELIVERY_REMINDER_NOT_REQUIRED",
    fix: expect.stringContaining("required: true"),
  }))
})

it("reports a Channel State transaction without a key with a code and a fix", async () => {
  await expect(runChannelStateTransaction({} as never, undefined, "", () => undefined)).rejects.toMatchObject({
    code: "AGENT_CHANNEL_STATE_TRANSACTION_INVALID",
    message: "[vitehub] channelState.transaction() needs a non-empty key.",
    fix: expect.stringContaining("channelState.transaction(key, run)"),
  })
})

it("reports context.pull() outside the Channel webhook route with a code and a fix", async () => {
  await expect(pullAgentChannel({ trigger: { id: "poll" } } as never, { key: "inbox", initialCursor: 0, fetch: async () => ({ items: [], next: 0, more: false }), trigger: "poll" } as never)).rejects.toMatchObject({
    code: "AGENT_CHANNEL_PULL_STATE_MISSING",
    fix: expect.stringContaining("context.pull()"),
  })
})
