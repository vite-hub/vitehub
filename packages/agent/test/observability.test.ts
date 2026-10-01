import { afterEach, expect, it, vi } from "vitest"
import { initLogger } from "evlog"
import { agentEvlogPlugin, createAgentEvlog, filterAgentObservability, sanitizeAgentLog, type AgentEvlogExporter } from "../src/evlog.ts"
import { agentInvocationId, defineAgent, runAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

const background: Promise<unknown>[] = []
const waitUntil = (task: Promise<unknown>) => { background.push(task) }
const instances: ReturnType<typeof createAgentEvlog>[] = []
function setup(overrides: Partial<AgentEvlogExporter> = {}, options = {}) {
  const exporter = {
    capture: vi.fn<AgentEvlogExporter["capture"]>(overrides.capture || (async () => {})),
    exception: vi.fn<AgentEvlogExporter["exception"]>(overrides.exception || (async () => {})),
    logs: vi.fn<AgentEvlogExporter["logs"]>(overrides.logs || (async () => {})),
    flush: vi.fn<AgentEvlogExporter["flush"]>(overrides.flush || (async () => {})),
  }
  const telemetry = createAgentEvlog({ service: "test", environment: "development", exporter, ...options })
  instances.push(telemetry)
  return { telemetry, exporter }
}
afterEach(async () => { await Promise.allSettled(instances.splice(0).map(item => item.flush())); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(["production", undefined])("adds resolved default identity to all telemetry with NODE_ENV %s", async (nodeEnv) => {
  vi.stubEnv("NODE_ENV", nodeEnv)
  try {
    const { telemetry, exporter } = setup({}, { service: undefined, environment: undefined })
    const identity = { service: "vitehub-agent", environment: nodeEnv || "development" }
    telemetry.event("default.event")
    await telemetry.capture("default.capture", {})
    telemetry.exception(new Error("default failure"))
    const agent = defineAgent({ driver: { run: () => "answer" }, capabilities: [telemetry.capability] })
    await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil }, { prompt: "hello" })
    await Promise.allSettled(background.splice(0))
    await telemetry.flush()
    expect(exporter.capture).toHaveBeenCalledWith("default.event", expect.objectContaining(identity), expect.anything())
    expect(exporter.capture).toHaveBeenCalledWith("default.capture", expect.objectContaining(identity), expect.anything())
    expect(exporter.capture).toHaveBeenCalledWith("$ai_trace", expect.objectContaining({ ...identity, status: "completed" }), expect.anything())
    expect(exporter.exception).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining(identity), expect.anything())
  }
  finally {
    vi.unstubAllEnvs()
  }
})

it("keeps concurrent invocation identity and terminal events separate", async () => {
  const { telemetry, exporter } = setup()
  const agent = defineAgent({ driver: { run: () => "answer" }, capabilities: [telemetry.capability] })
  await Promise.all(["one", "two"].map(runId => runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil, agentIdentity: { name: "bot" }, run: { runId } }, { prompt: "private" })))
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
  const calls = exporter.capture.mock.calls
  const terminal = calls.filter(([name]) => name === "$ai_trace")
  expect(terminal).toHaveLength(2)
  expect(new Set(terminal.map(([, data]) => data.run_id))).toEqual(new Set(["one", "two"]))
  expect(terminal.every(([, data]) => data.status === "completed" && data.invocation_id)).toBe(true)
  expect(JSON.stringify(calls)).not.toContain("private")
})

it.each(["failure", "cancelled"])("records %s without leaking driver errors", async (outcome) => {
  const { telemetry, exporter } = setup()
  const abort = new AbortController()
  const agent = defineAgent({ capabilities: [telemetry.capability], driver: { run() { if (outcome === "cancelled") abort.abort(); throw new Error("private prompt") } } })
  await expect(runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil }, { abortSignal: abort.signal })).rejects.toThrow()
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
  expect(exporter.capture).toHaveBeenCalledWith("$ai_trace", expect.objectContaining({ status: outcome === "failure" ? "failed" : "cancelled" }), expect.anything())
  expect(exporter.exception).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0)
  expect(JSON.stringify(exporter.exception.mock.calls)).not.toContain("private prompt")
})

it("bounds delivery, rejects explicit overflow, and aborts a stuck exporter", async () => {
  const signals: AbortSignal[] = []
  const { telemetry } = setup({ capture: async (_event, _properties, delivery) => { signals.push(delivery!.signal!); return new Promise(() => {}) } }, { maxPending: 1, deliveryTimeoutMs: 10 })
  const first = telemetry.capture("report", {})
  await expect(telemetry.capture("overflow", {})).rejects.toThrow("queue is full")
  await expect(first).rejects.toThrow("timed out")
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
  expect(signals[0]?.aborted).toBe(true)
  expect(telemetry.status()).toMatchObject({ failed: 1, dropped: 1, pending: 0, closed: true })
  await expect(telemetry.capture("closed", {})).rejects.toThrow("unavailable")
})

it("does not send an owned log to the global drain twice", async () => {
  const drain = vi.fn()
  initLogger({ drain, pretty: false })
  const { telemetry, exporter } = setup()
  telemetry.event("example", { service: "spoof", environment: "spoof" })
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
  expect(drain).not.toHaveBeenCalled()
  expect(exporter.logs).toHaveBeenCalledTimes(1)
  expect(exporter.capture).toHaveBeenCalledWith("example", expect.objectContaining({ service: "test", environment: "development" }), expect.anything())
})

it("supports logging without an exporter and makes unavailable delivery explicit", async () => {
  const telemetry = createAgentEvlog({ service: "local", environment: "test" })
  telemetry.event("local")
  expect(telemetry.status().configured).toBe(false)
  await expect(telemetry.capture("report", {})).rejects.toThrow("unavailable")
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
})

it("removes secrets and raw model content from nested log data", () => {
  const data: Record<string, unknown> = { prompt: "private", customer: "a@example.com", url: "https://user:pass@example.org/a?token=secret#secret", nested: { authorization: "secret", messages: ["private"], message: "Bearer abc" } }
  data.cycle = data
  expect(sanitizeAgentLog(data)).toEqual({ customer: "[EMAIL]", url: "https://example.org/a", nested: { message: "Bearer [REDACTED]" } })
})

it("filters minimal observability to lifecycle metadata", () => {
  expect(filterAgentObservability("minimal", {
    invocation_id: "inv-1", model: "gpt-test", duration_ms: 12,
    tool_name: "github", tool_input: "private", input_summary: "private",
    status: "completed", prompt: "private",
  })).toEqual({ invocation_id: "inv-1", model: "gpt-test", duration_ms: 12, status: "completed" })
})

it.each(["minimal", "standard", "full"] as const)("applies %s level before exporter delivery", async (level) => {
  const { telemetry, exporter } = setup({}, { level })
  telemetry.event("agent.lifecycle", { invocation_id: "i", prompt: "private prompt", output_summary: "safe summary", tool_name: "shell", tool_status: "ok" })
  await telemetry.flush()
  const payload = exporter.capture.mock.calls[0]?.[1] || {}
  if (level !== "full") expect(JSON.stringify(payload)).not.toContain("private prompt")
  if (level === "minimal") expect(payload).not.toHaveProperty("tool_name")
  if (level === "standard") expect(payload).toHaveProperty("output_summary", "safe summary")
  if (level === "full") expect(payload).toHaveProperty("prompt", "private prompt")
})

it("records a terminal event when a later capability fails to prepare", async () => {
  const { telemetry, exporter } = setup()
  const agent = defineAgent({ capabilities: [telemetry.capability, { id: "broken", prepare() { throw new Error("setup failed") } }], driver: { run: () => "unreachable" } })
  await expect(runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil }, {})).rejects.toThrow("setup failed")
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
  expect(exporter.capture).toHaveBeenCalledWith("$ai_trace", expect.objectContaining({ status: "failed" }), expect.anything())
})

it("exports streamed usage once after the stream ends", async () => {
  const { streamAgent } = await import("../src/index.ts")
  const { readUIMessageStream } = await import("ai")
  const { telemetry, exporter } = setup()
  const agent = defineAgent({ capabilities: [telemetry.capability], driver: { run: () => (async function* () {
    yield { type: "text-delta", text: "answer" }
    yield { type: "usage", usageRecord: { model: "test-model", usage: { totalTokens: 4 } } }
    yield { type: "finish" }
  })() } })
  const stream = await streamAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil }, {}, { output: "ui-message-stream" }) as ReadableStream<never>
  for await (const _message of readUIMessageStream({ stream })) {}
  await Promise.allSettled(background.splice(0))
  await telemetry.flush()
  const terminal = exporter.capture.mock.calls.filter(([name]) => name === "$ai_trace")
  expect(terminal).toHaveLength(1)
  expect(terminal[0]![1]).toMatchObject({ total_tokens: 4, model: "test-model", status: "completed" })
})

it("finishes an invocation while retaining slow delivery in the host lifetime", async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const { telemetry, exporter } = setup({ capture: async () => blocked })
  const agent = defineAgent({ driver: { run: () => "answer" }, capabilities: [telemetry.capability] })
  try {
    await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil }, { prompt: "hello" })
    expect(telemetry.status().pending).toBeGreaterThan(0)
    expect(exporter.capture).toHaveBeenCalled()
  }
  finally {
    release()
    await Promise.allSettled(background.splice(0))
  }
})

it("uses the existing evlog drain when no separate exporter is configured", async () => {
  const drain = vi.fn()
  initLogger({ drain, pretty: false })
  const telemetry = createAgentEvlog({ service: "configured-host", environment: "test" })
  telemetry.event("agent.event", { invocation_id: "one" })
  await telemetry.flush()
  expect(drain).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ invocation_id: "one", service: "configured-host" }) }))
})

it.each([
  ["bot", "bot"],
  ["team/support", "~007400650061006d002f0073007500700070006f00720074"],
  ["Reviewer", "~00520065007600690065007700650072"],
])("builds Console links and owns its host lifecycle for %j", async (name, segment) => {
  vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { [`discovered-${name}`]: "https://console.example" } })
  vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/inspect/")
  const { telemetry, exporter } = setup()
  const hooks = new Map<string, Function>()
  telemetry.plugin({ hooks: { hook(name, callback) { hooks.set(name, callback) }, removeHook() {} } })
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({ name, invocations, driver: { run: () => "answer" }, capabilities: [telemetry.capability] })
  await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil, agentIdentity: { name: `discovered-${name}` }, run: { runId: "links" } }, { prompt: "hello" })
  await Promise.allSettled(background.splice(0))
  const terminal = exporter.capture.mock.calls.find(([name]) => name === "$ai_trace")
  expect(await invocations.getByRunId("links", name)).toMatchObject({ agentName: name, id: await agentInvocationId("links", name) })
  expect(terminal?.[1].agent_name).toBe(name)
  expect(terminal?.[1].session_url).toBe(`https://console.example/inspect/_vitehub/agents/${segment}/invocations/${await agentInvocationId("links", name)}`)
  await hooks.get("close")!()
  expect(telemetry.status().closed).toBe(true)
})

it("exports only failed HTTP logs by default", async () => {
  const { telemetry, exporter } = setup()
  telemetry.drain({ event: { service: "test", environment: "development", level: "info", method: "GET", path: "/health", status: 200, timestamp: new Date().toISOString() }, request: { method: "GET", path: "/health" } })
  telemetry.drain({ event: { service: "test", environment: "development", level: "error", method: "POST", path: "/rpc", status: 500, timestamp: new Date().toISOString() }, request: { method: "POST", path: "/rpc" } })
  await telemetry.flush()
  expect(exporter.logs).toHaveBeenCalledTimes(1)
  expect(exporter.logs.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ path: "/rpc", status: 500 })])
})

it.each(["failures", "all", false] as const)("preserves application logs with HTTP log policy %s", async (logs) => {
  const { telemetry, exporter } = setup({}, { logs })
  telemetry.drain({ event: { service: "test", environment: "development", level: "info", event: "job.finished", timestamp: new Date().toISOString() } })
  telemetry.drain({ event: { service: "test", environment: "development", level: "debug", event: "job.progress", timestamp: new Date().toISOString() } })
  telemetry.drain({ event: { service: "test", environment: "development", level: "info", event: "outbound.finished", method: "GET", path: "/health", status: 200, timestamp: new Date().toISOString() } })
  telemetry.drain({ event: { service: "test", environment: "development", level: "info", method: "GET", path: "/health", status: 200, timestamp: new Date().toISOString() }, request: { method: "GET", path: "/health" } })
  telemetry.drain({ event: { service: "test", environment: "development", level: "error", method: "POST", path: "/rpc", status: 500, timestamp: new Date().toISOString() }, request: { method: "POST", path: "/rpc" } })
  await telemetry.flush()
  expect(exporter.logs).toHaveBeenCalledTimes(1)
  const records = exporter.logs.mock.calls[0]![0]
  expect(records.filter(record => record.event).map(record => record.event)).toEqual(["job.finished", "job.progress", "outbound.finished"])
  expect(records.filter(record => !record.event).map(record => record.status)).toEqual(logs === "all" ? [200, 500] : logs === "failures" ? [500] : [])
})

it.each(["minimal", "standard", "full"] as const)("logs HTTP 4xx failures with request metadata at %s level", async (level) => {
  const { telemetry, exporter } = setup({}, { level, logs: false })
  const hooks = new Map<string, Function>()
  agentEvlogPlugin(telemetry)({ hooks: { hook(name, callback) { hooks.set(name, callback) }, removeHook() {} } })
  const req = Object.assign(new Request("https://example.test/missing?token=secret"), { context: { requestId: "req-1" } })
  hooks.get("error")!(Object.assign(new Error("Not found"), { statusCode: 404 }), { event: { req } })
  await telemetry.flush()
  expect(exporter.exception).not.toHaveBeenCalled()
  expect(exporter.capture).toHaveBeenCalledWith("http.request.failed", expect.objectContaining({ level: "warn", status_code: 404, request_id: "req-1", method: "GET", path: "/missing", operation: "http.request" }), expect.anything())
})

it("keeps non-request 4xx failures as exceptions", async () => {
  const { telemetry, exporter } = setup()
  const hooks = new Map<string, Function>()
  agentEvlogPlugin(telemetry)({ hooks: { hook(name, callback) { hooks.set(name, callback) }, removeHook() {} } })
  hooks.get("error")!(Object.assign(new Error("Upstream rejected background task"), { statusCode: 403 }), {})
  await telemetry.flush()
  expect(exporter.exception).toHaveBeenCalledTimes(1)
  expect(exporter.capture).not.toHaveBeenCalled()
})

it.each([500, 503])( "keeps HTTP %s failures as exceptions", async (statusCode) => {
  const { telemetry, exporter } = setup()
  const hooks = new Map<string, Function>()
  agentEvlogPlugin(telemetry)({ hooks: { hook(name, callback) { hooks.set(name, callback) }, removeHook() {} } })
  const req = Object.assign(new Request("https://example.test/fail"), { context: { requestId: "req-5xx" } })
  hooks.get("error")!(Object.assign(new Error("Server error"), { statusCode }), { event: { req } })
  await telemetry.flush()
  expect(exporter.exception).toHaveBeenCalledTimes(1)
})

it.each(["statusCode", "status"])("keeps errors with a throwing %s getter on the exception path", async (property) => {
  const { telemetry, exporter } = setup()
  const hooks = new Map<string, Function>()
  agentEvlogPlugin(telemetry)({ hooks: { hook(name, callback) { hooks.set(name, callback) }, removeHook() {} } })
  const error = Object.defineProperty(new Error("Unknown failure"), property, {
    get() { throw new Error("Cannot inspect status") },
  })
  const req = new Request("https://example.test/fail")
  expect(() => hooks.get("error")!(error, { event: { req } })).not.toThrow()
  await telemetry.flush()
  expect(exporter.exception).toHaveBeenCalledTimes(1)
  expect(exporter.capture).not.toHaveBeenCalled()
})

it("installs one host instance for useObservability() and every Agent", async () => {
  const { useObservability } = await import("../src/observability.ts")
  const { installObservability } = await import("../src/observability/host.ts")
  const { createMemoryAgentInvocationStore, defineAgentInvocations } = await import("../src/server.ts")
  expect(() => useObservability()).toThrow("Observability is not configured")
  const exporter = { capture: vi.fn(async () => {}), exception: vi.fn(async () => {}), logs: vi.fn(async () => {}), flush: vi.fn(async () => {}) }
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const plugin = installObservability({ service: "host", exporter, papercuts: { invocations: () => invocations } })
  const closeHooks: Function[] = []
  plugin({ hooks: { hook(name, callback) { if (name === "close") closeHooks.push(callback) }, removeHook() {} } })
  const observability = useObservability()
  expect(observability.status()).toMatchObject({ configured: true, papercuts: { running: true, pending: 0, delivered: 0, failed: 0 } })

  // The Agent declares no Capabilities; the host instance still receives its terminal event.
  const agent = defineAgent({ driver: { run: () => "answer" } })
  await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil, agentIdentity: { name: "bot" }, run: { runId: "host" } }, { prompt: "hello" })
  await Promise.allSettled(background.splice(0))
  expect(exporter.capture).toHaveBeenCalledWith("$ai_trace", expect.objectContaining({ agent_name: "bot", service: "host", status: "completed" }), expect.anything())

  for (const close of closeHooks) await close()
  expect(observability.status().closed).toBe(true)
  expect(() => useObservability()).toThrow("Observability is not configured")
})

it("clears host Observability when exporter shutdown flush rejects", async () => {
  const { installObservability } = await import("../src/observability/host.ts")
  const { useObservability } = await import("../src/observability.ts")
  const closeHooks: Array<() => Promise<void>> = []
  const host = (close: Array<() => Promise<void>>) => ({
    hooks: {
      hook(...registration: [name: "close", callback: () => Promise<void>] | [name: "request" | "evlog:drain" | "error", callback: unknown]) {
        if (registration[0] === "close") close.push(registration[1])
      },
      removeHook() {},
    },
  })
  installObservability({ service: "failed-host", exporter: { capture: async () => {}, exception: async () => {}, logs: async () => {}, flush: async () => { throw new Error("flush failed") } } })(host(closeHooks))
  await expect((async () => { for (const close of closeHooks) await close() })()).rejects.toThrow("flush failed")
  expect(() => useObservability()).toThrow("Observability is not configured")
  const replacementClose: Array<() => Promise<void>> = []
  installObservability({ service: "replacement" })(host(replacementClose))
  for (const close of replacementClose) await close()
})

it("rolls back host Observability when host attachment fails", async () => {
  const { installObservability } = await import("../src/observability/host.ts")
  const { useObservability } = await import("../src/observability.ts")
  const plugin = installObservability({ service: "failed-attachment" })
  expect(() => plugin({ hooks: { hook() { throw new Error("hook failed") }, removeHook() {} } })).toThrow("hook failed")
  expect(() => useObservability()).toThrow("Observability is not configured")

  const closeHooks: Array<() => Promise<void>> = []
  installObservability({ service: "retry" })({
    hooks: {
      hook(name, callback) { if (name === "close") closeHooks.push(callback as () => Promise<void>) },
      removeHook() {},
    },
  })
  for (const close of closeHooks) await close()
})

it("cleans up telemetry when a later host attachment hook fails", async () => {
  const { installObservability } = await import("../src/observability/host.ts")
  const { useObservability } = await import("../src/observability.ts")
  const flush = vi.fn(async () => {})
  const plugin = installObservability({ service: "partial-attachment", exporter: { capture: async () => {}, exception: async () => {}, logs: async () => {}, flush } })
  const removed: string[] = []
  expect(() => plugin({ hooks: {
    hook(name) { if (name === "close") throw new Error("close hook failed") },
    removeHook(name) { removed.push(name) },
  } })).toThrow("close hook failed")
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(flush).toHaveBeenCalledOnce()
  expect(removed).toEqual(["request", "evlog:drain", "error"])
  expect(() => useObservability()).toThrow("Observability is not configured")
})

it("uses hook disposers when a host exposes removeHook", async () => {
  const { installObservability } = await import("../src/observability/host.ts")
  const { useObservability } = await import("../src/observability.ts")
  const flush = vi.fn(async () => {})
  const disposers: Array<() => void> = []
  const plugin = installObservability({ service: "disposer-attachment", exporter: { capture: async () => {}, exception: async () => {}, logs: async () => {}, flush } })
  expect(() => plugin({ hooks: {
    hook(name) {
      if (name === "close") throw new Error("close hook failed")
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    },
    removeHook() {},
  } })).toThrow("close hook failed")
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(flush).toHaveBeenCalledOnce()
  expect(disposers).toHaveLength(3)
  for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce()
  expect(() => useObservability()).toThrow("Observability is not configured")
})

it("preserves host ownership and replaces injected Capabilities after shutdown", async () => {
  const { useObservability } = await import("../src/observability.ts")
  const { installObservability } = await import("../src/observability/host.ts")
  const firstClose: Function[] = []
  const secondClose: Function[] = []
  const first = installObservability({ service: "first", exporter: { capture: vi.fn(async () => {}), exception: vi.fn(async () => {}), logs: vi.fn(async () => {}), flush: vi.fn(async () => {}) } })
  first({ hooks: { hook(name, callback) { if (name === "close") firstClose.push(callback) }, removeHook() {} } })
  const firstInstance = useObservability()
  let firstClosed = false
  try {
    expect(() => installObservability({ service: "second" })).toThrow("Close its host")
    expect(useObservability()).toBe(firstInstance)
    expect(() => defineAgent({ capabilities: [{ id: "observability" }], driver: { run: () => "answer" } })).toThrow()
    expect(() => defineAgent({ capabilities: [{ id: "custom", capabilities: [{ id: "observability" }] }], driver: { run: () => "answer" } })).toThrow()
    const agent = defineAgent({ driver: { run: () => "answer" } })
    for (const close of firstClose) await close()
    firstClosed = true
    const capture = vi.fn(async () => {})
    const second = installObservability({ service: "second", exporter: { capture, exception: vi.fn(async () => {}), logs: vi.fn(async () => {}), flush: vi.fn(async () => {}) } })
    second({ hooks: { hook(name, callback) { if (name === "close") secondClose.push(callback) }, removeHook() {} } })
    await runAgent(agent, { runtime: "unknown", memo: vi.fn(), waitUntil, agentIdentity: { name: "bot" }, run: { runId: "replacement" } }, { prompt: "hello" })
    await Promise.allSettled(background.splice(0))
    expect(capture).toHaveBeenCalledWith("$ai_trace", expect.objectContaining({ service: "second", status: "completed" }), expect.anything())
  }
  finally {
    if (!firstClosed) for (const close of firstClose) await close()
    for (const close of secondClose) await close()
  }
  expect(() => useObservability()).toThrow("Observability is not configured")
})
