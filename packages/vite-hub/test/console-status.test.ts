import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { H3 } from "h3"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { getConsoleAgentDefinition, installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import agentInvocationsHandlerRoute from "../src/console/runtime/server/agent-invocations.post.ts"
import statusHandlerRoute from "../src/console/runtime/server/status.get.ts"
import { createAgentStatusReader } from "@vite-hub/agent/server"
import type { AgentInput, AgentProviderStatus } from "@vite-hub/agent"
import type { H3Config } from "h3"
import { allowed } from "./support/console-access.ts"

const agentInvocationsHandler = allowed(agentInvocationsHandlerRoute)
const statusHandler = allowed(statusHandlerRoute)

const ready: AgentProviderStatus = { agent: "bot", checkedAt: "2026-09-05T12:00:00.000Z", readiness: "ready", stale: false }
const agent = (status?: AgentInput["status"]): AgentInput => ({ resolve: vi.fn(), status })
afterEach(() => vi.useRealTimers())

describe("Console status", () => {
  it("inspects registered definitions while task execution is disabled", async () => {
    const store = createMemoryAgentInvocationStore()
    const create = vi.spyOn(store, "create")
    const invocations = defineAgentInvocations({ store })
    const definition = agent(vi.fn(async () => ready))
    installConsoleInvocations(process.cwd(), invocations)
    installConsoleAgentDefinitions([{ definition, fallbackName: "bot" }], { invocations })

    expect(getConsoleAgentDefinition("bot")).toBeUndefined()
    expect(await statusHandler({ method: "GET", req: { url: "http://localhost/api/_vitehub/console/status?agent=bot" } })).toEqual({ agents: [ready], observability: null })
    expect(getConsoleAgentDefinition("bot")).toBeUndefined()
    await expect(agentInvocationsHandler({ method: "POST", context: { params: { agent: "bot" } } })).rejects.toMatchObject({ statusCode: 404 })
    expect(definition.resolve).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it("includes HTTP status messages for invalid and unavailable status requests", async () => {
    const invalid = "a".repeat(513)
    await expect(statusHandler({ method: "GET", req: { url: `http://localhost/api/_vitehub/console/status?agent=${invalid}` } })).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "Invalid Agent name.",
    })
    await expect(statusHandler({ method: "GET", req: { url: "http://localhost/api/_vitehub/console/status?agent=missing" } })).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: "Agent status is unavailable.",
    })

    const require = createRequire(import.meta.url)
    const nitroRoot = dirname(require.resolve("nitro/package.json"))
    const { default: onError }: { default: NonNullable<H3Config["onError"]> } = await import(pathToFileURL(join(nitroRoot, "dist/runtime/internal/error/prod.mjs")).href)
    // SAFETY: Mount the direct Nitro handler on H3 with Nitro's production error serializer.
    const app = new H3({ onError }).get("/api/_vitehub/console/status", statusHandler as never)
    const invalidResponse = await app.request(`/api/_vitehub/console/status?agent=${invalid}`)
    expect(invalidResponse.status).toBe(400)
    await expect(invalidResponse.json()).resolves.toMatchObject({ error: true, status: 400, statusText: "Invalid Agent name.", message: "Invalid Agent name." })
    const unavailableResponse = await app.request("/api/_vitehub/console/status?agent=missing")
    expect(unavailableResponse.status).toBe(404)
    await expect(unavailableResponse.json()).resolves.toMatchObject({ error: true, status: 404, statusText: "Agent status is unavailable.", message: "Agent status is unavailable." })
  })

  it("reports the observability exporter and papercut backlog", async () => {
    const status = { configured: false, accepted: 0, failed: 1, dropped: 0, pending: 0, closed: false, papercuts: { running: false, pending: 0, delivered: 0, failed: 1 } }
    const slot = Symbol.for("vitehub.observability")
    Object.assign(globalThis, { [slot]: { capability: { id: "observability" }, status: () => status } })
    try {
      installConsoleAgentDefinitions([{ definition: agent(vi.fn(async () => ready)), fallbackName: "bot" }], { invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }) })
      expect(await statusHandler({ method: "GET", req: { url: "http://localhost/api/_vitehub/console/status?agent=bot" } })).toEqual({ agents: [ready], observability: status })
    }
    finally {
      Reflect.deleteProperty(globalThis, slot)
    }
  })

  it("shares concurrent probes and cached results per definition", async () => {
    const probe = vi.fn<NonNullable<AgentInput["status"]>>(async () => ready)
    const definition = agent(probe)
    const read = createAgentStatusReader()
    await Promise.all([read(definition, "bot"), read(definition, "bot")])
    await read(definition, "bot")
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]?.[0]).toMatchObject({ agentIdentity: { name: "bot" } })
    await read(agent(probe), "bot")
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it("reports unsupported definitions without invoking them", async () => {
    const definition = agent()
    expect(await createAgentStatusReader()(definition, "bot")).toMatchObject({ readiness: "unsupported" })
    expect(definition.resolve).not.toHaveBeenCalled()
  })
  it("retains old evidence as stale after a failed refresh", async () => {
    vi.useFakeTimers()
    const probe = vi.fn().mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error("credential secret"))
    const definition = agent(probe)
    const read = createAgentStatusReader({ maxAgeMs: 30 })
    await read(definition, "bot")
    await vi.advanceTimersByTimeAsync(31)
    expect(await read(definition, "bot")).toEqual({ ...ready, readiness: "unknown", stale: true, reason: "Provider inspection failed." })
  })
  it("aborts timed out probes and prevents overlap while cleanup is pending", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    let settle!: (value: AgentProviderStatus) => void
    const probe = vi.fn((_context, options) => {
      signal = options?.abortSignal
      return new Promise<AgentProviderStatus>(resolve => { settle = resolve })
    })
    const definition = agent(probe)
    const read = createAgentStatusReader({ timeoutMs: 10, maxAgeMs: 1 })
    const result = read(definition, "bot")
    await vi.advanceTimersByTimeAsync(11)
    expect(await result).toMatchObject({ readiness: "unknown", reason: "Provider inspection timed out." })
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    await read(definition, "bot")
    expect(probe).toHaveBeenCalledTimes(1)
    settle(ready)
    await vi.advanceTimersByTimeAsync(1)
  })
})
