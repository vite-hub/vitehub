import { expect, it } from "vitest"

import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { normalizeAgentOptions } from "../src/config.ts"
import { codexDriver, defineAgent } from "../src/index.ts"
import { invocationDiagnostics } from "../src/invocation-diagnostics.ts"
import { resolveAgentInvocationsSetting } from "../src/invocations/app.ts"

const codes = [
  "AGENT_CAPABILITY_EXTEND_ID_CHANGED",
  "AGENT_CAPABILITY_ID_MISSING",
  "AGENT_CHANNEL_ACTIVITY_UNSUPPORTED",
  "AGENT_CONFIG_KEY_INVALID",
  "AGENT_CONFIGURE_RESULT_INVALID",
  "AGENT_CONFIGURED_OPTIONS_INVALID",
  "AGENT_CUSTOM_INSTRUCTIONS_NOT_STRING",
  "AGENT_CUSTOM_INSTRUCTIONS_REFERENCE_INVALID",
  "AGENT_CUSTOM_INSTRUCTIONS_SLOT_MISSING",
  "AGENT_DRAIN_MS_INVALID",
  "AGENT_EXTENDS_INVALID",
  "AGENT_INLINE_INVOCATION_WORKFLOW",
  "AGENT_INSTRUCTION_SLOT_INVALID",
  "AGENT_INSTRUCTIONS_EXTEND_INVALID",
  "AGENT_INVOCATION_CLAIM_UNAVAILABLE",
  "AGENT_INVOCATION_STORE_OPEN_FAILED",
  "AGENT_INVOCATION_STORE_TIMEOUT",
  "AGENT_INVOCATION_STORE_UNCONFIRMED",
  "AGENT_INVOCATION_TOOL_NAME_TAKEN",
  "AGENT_INVOCATIONS_DATABASE_DRIVER_UNSUPPORTED",
  "AGENT_INVOCATIONS_DATABASE_WITHOUT_STORE",
  "AGENT_NAME_DUPLICATE",
  "AGENT_PRESET_OPTION_UNSUPPORTED",
  "AGENT_PRESET_OPTIONS_CONFLICT",
  "AGENT_PRESET_OPTIONS_INVALID",
  "AGENT_PRESET_OPTIONS_WITHOUT_CONFIGURE",
  "AGENT_PRESET_UNKNOWN",
  "AGENT_REPLAY_TASK_OTHER_AGENT",
  "AGENT_UI_STREAM_MISSING",
  "AGENT_WORKFLOW_REPLAY_UNSAFE",
] as const

const params = { capabilities: true, channelId: "c", id: "c", ms: 1, name: "n", names: ["n"], need: "a D1 batch driver that returns rows", reason: "Workflow dispatch identity changed", step: "store open", task: "t" } as const

it("gives each Agent definition and Invocation code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: each code reads only the params it declares from this shared object.
    const error = (agentDiagnostics[code] as (input: typeof params) => Error & { fix?: string, docs?: string })(params)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
  const cursor = invocationDiagnostics.AGENT_INVOCATION_CURSOR_REPEATED()
  expect(cursor.fix).toMatch(/\S/)
  expect(cursor.docs).toBe("https://vitehub.dev/docs/agents/diagnostics/agent_invocation_cursor_repeated")
})

it("reports options on an Agent without configure with a code and a fix", () => {
  const error = (() => {
    try { defineAgent({ options: {}, driver: codexDriver() } as never) }
    catch (caught) { return caught }
  })()
  expect(error).toMatchObject({
    code: "AGENT_PRESET_OPTIONS_WITHOUT_CONFIGURE",
    message: "[vitehub] Agent options require a preset with options and configure.",
    fix: expect.stringContaining("defineAgent({ options, configure })"),
  })
  // A definition error keeps the input-error status that the TypeError had.
  expect(isAgentTypeDiagnostic(error)).toBe(true)
})

it("reports a removed preset option with a code and a fix", () => {
  expect(() => defineAgent({ preset: "notes" } as never)).toThrow(expect.objectContaining({
    code: "AGENT_PRESET_OPTION_UNSUPPORTED",
    fix: expect.stringContaining("defineAgent({ extends: babysitter })"),
  }))
})

it("reports a negative shutdown drain with a code and a fix", () => {
  expect(() => normalizeAgentOptions({ shutdown: { drainMs: -1 } })).toThrow(expect.objectContaining({
    code: "AGENT_DRAIN_MS_INVALID",
    fix: expect.stringContaining("vitehub({ agent: { shutdown: { drainMs } } })"),
  }))
})

it("reports a database option without the database store with a code and a fix", () => {
  expect(() => resolveAgentInvocationsSetting({ store: "memory", database: "default" } as never)).toThrow(expect.objectContaining({
    code: "AGENT_INVOCATIONS_DATABASE_WITHOUT_STORE",
    fix: expect.stringContaining("store: \"database\""),
  }))
})
