import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UserConfig } from "vite"

import { defineChannel, defineChannelTrigger, ignored } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { isRuntimeFunction } from "../src/internal/runtime-value.ts"
import { createChannelWebhookRouteHandler, createAgentWebhookWarmup } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const hostedAgentRoot = join(import.meta.dirname, "../../../fixtures/tutorials/agents")
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function hookAgent(secretToken: () => string) {
  return defineAgent({
    channels: {
      hook: defineChannel("hook", {
        messages: false,
        triggers: { webhook: defineChannelTrigger({ invoke: () => ignored("unused") }) },
        webhooks: { path: "/hook", provider: "hook", secretHeader: "x-hub-signature-256", secretToken, signature: "github-sha256" },
      }),
    },
    driver: { run: () => "unused" },
  })
}

async function libsqlState() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-webhook-warm-"))
  const state = createLibsqlAgentState({ url: `file:${join(dir, "state.sqlite")}` })
  cleanups.push(async () => {
    await state.disconnect()
    await rm(dir, { force: true, recursive: true })
  })
  return state
}

describe("webhook handler warm()", () => {
  it("resolves secrets and connects webhook State with its backend ID before the first delivery", async () => {
    const state = await libsqlState()
    const connect = vi.spyOn(state, "connect")
    const secret = vi.fn(() => "secret")
    // SAFETY: The test Agent satisfies the route handler contract.
    const handler = createChannelWebhookRouteHandler(hookAgent(secret) as never)

    await handler.warm({ agentName: "warm", state, webhookState: state })

    expect(secret).toHaveBeenCalled()
    expect(connect).toHaveBeenCalled()
    await expect(state.get("webhook:backend-id")).resolves.toEqual(expect.any(String))
  })

  it("rejects with the error the first delivery would get", async () => {
    const state = await libsqlState()
    // SAFETY: The test Agent satisfies the route handler contract.
    const handler = createChannelWebhookRouteHandler(hookAgent(() => {
      throw new Error("secret store is down")
    }) as never)

    await expect(handler.warm({ agentName: "warm", state, webhookState: state })).rejects.toThrow("secret store is down")
  })
})

describe("createAgentWebhookWarmup()", () => {
  it("answers 503 while warming and 200 with per-Agent durations after", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const gate = deferred()
    const warmup = createAgentWebhookWarmup({ support: async () => await gate.promise, triage: async () => {} })

    const warming = warmup.warm()
    expect(warmup.warm()).toBe(warming)
    const before = warmup.response("GET")
    expect(before.status).toBe(503)
    await expect(before.json()).resolves.toMatchObject({ agents: { support: { status: "warming" } }, ready: false, status: "warming" })
    expect(await warmup.response("HEAD").text()).toBe("")

    gate.resolve()
    await warming
    const after = warmup.response("GET")
    expect(after.status).toBe(200)
    expect(after.headers.get("cache-control")).toBe("no-store")
    await expect(after.json()).resolves.toMatchObject({
      agents: { support: { durationMs: expect.any(Number), status: "ready" }, triage: { durationMs: expect.any(Number), status: "ready" } },
      ready: true,
      readyAt: expect.any(String),
      startedAt: expect.any(String),
      status: "ready",
    })
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"scope":"vitehub.agent.ready"'))
  })

  it("reports a failed warm-up with 503 and tries again after retryMs", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "info").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    let attempts = 0
    const warmup = createAgentWebhookWarmup({
      support: async () => {
        attempts++
        if (attempts === 1) throw new Error("State is not reachable")
      },
    })

    await warmup.warm()
    const failed = warmup.response("GET")
    expect(failed.status).toBe(503)
    await expect(failed.json()).resolves.toMatchObject({
      agents: { support: { error: "State is not reachable", status: "error" } },
      error: "State is not reachable",
      ready: false,
      retryMs: 5_000,
      status: "error",
    })
    expect(error).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(attempts).toBe(2)
    expect(warmup.readiness()).toMatchObject({ ready: true, status: "ready" })
    expect(warmup.readiness()).not.toHaveProperty("error")
  })
})

async function generate(options: Record<string, unknown>) {
  const { hubAgent } = await import("../src/vite.ts")
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-ready-route-"))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  await mkdir(join(root, "server", "agents"), { recursive: true })
  await writeFile(join(root, "server", "agents", "support.ts"), "export default {}", "utf8")
  const plugin = hubAgent({ providers: { state: { provider: "libsql", url: "file:agent-state.sqlite" } }, ...options })
  if (!isRuntimeFunction(plugin.configResolved)) throw new TypeError("Expected Agent configResolved hook.")
  // SAFETY: The hook reads only command and root from this test config.
  await plugin.configResolved.call({} as never, { command: "build", root } as never)
  const read = (file: string) => readFile(join(root, ".vitehub/agent", file), "utf8")
  return { read }
}

async function nitroHandlers(options: Record<string, unknown>, handlers: unknown[] = []) {
  const { hubAgent } = await import("../src/vite.ts")
  const plugin = hubAgent(options)
  if (!isRuntimeFunction(plugin.config)) throw new Error("Expected the Agent Vite config hook.")
  const config = { nitro: { handlers }, root: hostedAgentRoot }
  // SAFETY: The fixture supplies only the config fields read by the Agent config hook.
  await plugin.config.call({} as never, config as UserConfig, { command: "build", mode: "production" })
  // The hook replaces the Nitro config in place.
  // SAFETY: The hook writes a Nitro config with a handler list.
  return (config.nitro.handlers as Array<{ handler: string, route: string }>)
}

describe("generated readiness route", () => {
  it("warms every webhook handler and answers from the warm-up state", async () => {
    const { read } = await generate({})
    const route = await read("chat-webhook-route.ts")
    expect(route).toContain('import { createAgentWebhookWarmup } from "@vite-hub/agent/server/internal"')
    expect(route).toContain("() => handler.warm({ agentIdentity: agentIdentities[name], state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver }),")
    expect(route).toContain("export const warmWebhookRoutes = () => webhookWarmup.warm()")
    const ready = await read("ready-route.ts")
    expect(ready).toContain('import { warmWebhookRoutes, webhookRoutesReadyResponse } from "./chat-webhook-route"')
    expect(ready).toContain("void warmWebhookRoutes()")
    expect(ready).toContain("return webhookRoutesReadyResponse(")
  })

  it("makes the Workspace preparation route wait for the warm-up and generates no second route", async () => {
    const { read } = await generate({ preparation: { workspace: "docs" } })
    const preparation = await read("preparation-route.ts")
    expect(preparation).toContain("if (!webhookRoutesReadiness().ready) return webhookRoutesReadyResponse(method)")
    expect(preparation).toContain("return preparation.response(method)")
    await expect(read("ready-route.ts")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("registers /api/_vitehub/ready with Nitro unless preparation or the application owns it", async () => {
    expect(await nitroHandlers({})).toContainEqual({ handler: join(hostedAgentRoot, ".vitehub/agent/ready-route.ts"), route: "/api/_vitehub/ready" })

    const withPreparation = await nitroHandlers({ preparation: { workspace: "docs" } })
    expect(withPreparation.filter(handler => handler.route === "/api/_vitehub/ready")).toEqual([
      { handler: join(hostedAgentRoot, ".vitehub/agent/preparation-route.ts"), route: "/api/_vitehub/ready" },
    ])

    const own = { handler: "/app/ready.ts", route: "/api/_vitehub/ready" }
    const withOwn = await nitroHandlers({}, [own])
    expect(withOwn.filter(handler => handler.route === "/api/_vitehub/ready")).toEqual([own])
  })
})
