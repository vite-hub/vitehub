import { afterEach, expect, it, vi } from "vitest"
import { initLogger } from "evlog"
import { createAgentEvlog, filterAgentObservability, sanitizeAgentLog, type AgentEvlogExporter } from "../src/evlog.ts"
import { defineAgent, runAgent } from "../src/index.ts"

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
afterEach(async () => { await Promise.allSettled(instances.splice(0).map(item => item.flush())); vi.restoreAllMocks() })

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
  expect(JSON.stringify(payload)).not.toContain("private prompt")
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
