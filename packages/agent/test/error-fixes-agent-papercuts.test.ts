import { expect, it } from "vitest"

import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { budget, createPapercutIndex, papercuts, posthogPapercuts } from "../src/capabilities/index.ts"
import { posthog } from "../src/observability/posthog.ts"

const codes = [
  "AGENT_BROWSER_CACHE_UNTRUSTED",
  "AGENT_BROWSER_INSTALL_FAILED",
  "AGENT_BROWSER_MANAGED_WITH_LAUNCH",
  "AGENT_BROWSER_PLATFORM_UNSUPPORTED",
  "AGENT_BROWSER_SOCKET_DIRECTORY_UNSAFE",
  "AGENT_BUDGET_CAPACITY_UNSUPPORTED",
  "AGENT_BUDGET_LIMIT_INVALID",
  "AGENT_BUDGET_LIMIT_MISSING",
  "AGENT_BUDGET_USD_INVALID",
  "AGENT_EXECUTION_BUDGET_AI_SDK_UNSUPPORTED",
  "AGENT_MAX_RETRIES_INVALID",
  "AGENT_MCP_RETRIES_INVALID",
  "AGENT_MCP_TOOLS_LIST_INVALID",
  "AGENT_OBSERVABILITY_INSTALLED",
  "AGENT_OBSERVABILITY_MAX_PENDING_INVALID",
  "AGENT_OPENAPI_CONNECTION_BODY_INVALID",
  "AGENT_PAPERCUT_DELIVERY_INVALID",
  "AGENT_PAPERCUT_IDENTITY_MISSING",
  "AGENT_PAPERCUT_INDEX_OPTION_INVALID",
  "AGENT_PAPERCUT_INDEX_SIMILARITY_INVALID",
  "AGENT_PAPERCUT_INVALID",
  "AGENT_PAPERCUT_MESSAGE_MISSING",
  "AGENT_PAPERCUT_MESSAGE_TOO_LONG",
  "AGENT_PAPERCUT_NOT_PERSISTED",
  "AGENT_PAPERCUT_REPORTER_CLOSED",
  "AGENT_PAPERCUTS_BACKEND_MISSING",
  "AGENT_PAPERCUTS_CLI_INVALID",
  "AGENT_PAPERCUTS_DEDUPE_INVALID",
  "AGENT_POSTHOG_API_KEY_MISSING",
  "AGENT_POSTHOG_DELIVERY_UNACKNOWLEDGED",
  "AGENT_POSTHOG_HOST_INVALID",
  "AGENT_POSTHOG_PAPERCUT_DELIVERY_FAILED",
  "AGENT_POSTHOG_PAPERCUTS_API_KEY_MISSING",
  "AGENT_PROVIDER_CHECKOUT_HEAD_CHANGED",
  "AGENT_PROVIDER_FILES_CONFLICTED",
  "AGENT_SKILL_NAME_INVALID",
  "AGENT_STATE_ATOMIC_LOCK_MISSING",
  "AGENT_STATE_LOCK_EXPIRED",
  "AGENT_TELEMETRY_QUEUE_FULL",
  "AGENT_TELEMETRY_UNAVAILABLE",
  "AGENT_TIMER_DURATION_INVALID",
  "AGENT_TOOL_SCHEMA_ASYNC_VALIBOT",
  "AGENT_WORKSPACE_COMMAND_CWD_OUTSIDE",
  "AGENT_WORKSPACE_GIT_INIT_FAILED",
] as const

const params = { ancestors: true, arch: true, explicit: true, files: ["a.ts"], key: "k", max: 1000, name: "windowMs", option: "evlog deliveryTimeoutMs", path: "/tmp/cache", status: 401, step: "report" } as const

it("gives each papercut, browser, budget, observability, and provider code a fix and its own docs page", () => {
  for (const code of codes) {
    // SAFETY: each code reads only the params it declares from this shared object.
    const error = (agentDiagnostics[code] as (input: typeof params) => Error & { fix?: string, docs?: string })(params)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports papercuts() without a backend with a code and a fix", () => {
  const error = (() => {
    try { papercuts({} as never) }
    catch (caught) { return caught }
  })()
  expect(error).toMatchObject({
    code: "AGENT_PAPERCUTS_BACKEND_MISSING",
    message: "[vitehub] papercuts() requires a report callback or backend.",
    fix: expect.stringContaining("posthogPapercuts({ apiKey })"),
  })
  // An option error keeps the input-error status that the TypeError had.
  expect(isAgentTypeDiagnostic(error)).toBe(true)
})

it("reports posthogPapercuts() without an apiKey with a code and a fix", () => {
  expect(() => posthogPapercuts({} as never)).toThrow(expect.objectContaining({
    code: "AGENT_POSTHOG_PAPERCUTS_API_KEY_MISSING",
    fix: expect.stringContaining("posthogPapercuts({ apiKey })"),
  }))
})

it("reports a budget() without limits with a code and a fix", () => {
  expect(() => budget({})).toThrow(expect.objectContaining({
    code: "AGENT_BUDGET_LIMIT_MISSING",
    fix: expect.stringContaining("budget({ usd"),
  }))
})

it("reports a bad createPapercutIndex() similarity and a bad posthog() host with codes and fixes", () => {
  expect(() => createPapercutIndex({ similarity: 2 })).toThrow(expect.objectContaining({
    code: "AGENT_PAPERCUT_INDEX_SIMILARITY_INVALID",
    fix: expect.stringContaining("createPapercutIndex({ similarity })"),
  }))
  expect(() => posthog({ apiKey: "phc_test", host: "ftp://posthog.example" })).toThrow(expect.objectContaining({
    code: "AGENT_POSTHOG_HOST_INVALID",
    fix: expect.stringContaining("posthog({ host })"),
  }))
})

it("gives each Channels operation code a fix and its own docs page", () => {
  const errors = [
    agentDiagnostics.AGENT_CHANNELS_ADAPTER_MISSING(),
    agentDiagnostics.AGENT_CHANNELS_CURSOR_INVALID(),
    agentDiagnostics.AGENT_CHANNELS_EXPORT_TOO_LARGE({ archive: "export" }),
    agentDiagnostics.AGENT_CHANNELS_FORBIDDEN({ problem: "participant" }),
    agentDiagnostics.AGENT_CHANNELS_HOST_UNAVAILABLE({ read: "host" }),
    agentDiagnostics.AGENT_CHANNELS_NO_CONVERSATIONS({ channel: "\"gmail\"" }),
    agentDiagnostics.AGENT_CHANNELS_NO_STATUS({ channel: "\"slack\"" }),
    agentDiagnostics.AGENT_CHANNELS_NOT_FOUND({ channel: "\"slack\"", problem: "unknown" }),
    agentDiagnostics.AGENT_CHANNELS_PROVIDER_FAILED({ detail: "down" }),
    agentDiagnostics.AGENT_CHANNELS_THREAD_UNKNOWN({ thread: "\"t\"" }),
  ]
  for (const error of errors) {
    expect(error.message, error.code).toMatch(/\S/)
    expect(error.fix, error.code).toMatch(/\S/)
    expect(error.docs, error.code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${error.code.toLowerCase()}`)
  }
})
