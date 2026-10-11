import { createHmac } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAgent, resolveAgentTriggerInvocation } from "../src/index.ts"
import { babysitter } from "../src/presets/babysitter.ts"
import { getAgentProcessHostContribution, registerAgentProcessHostIntake, withAgentProcessHost, type AgentProcessHostInstance } from "../src/agent-process-host.ts"
import { usesProcessHostPreset } from "../src/discovery.ts"
import { createAgentProcessHosts } from "../src/runtime/process.ts"
import { isRuntimeFunction } from "../src/internal/runtime-value.ts"

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  registerAgentProcessHostIntake("babysitter", undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const babysitterSource = `import { defineAgent } from "vite-hub/agent"\nimport { babysitter } from "vite-hub/agent/presets/babysitter"\nexport default defineAgent({ preset: "babysitter", presets: { babysitter }, options: { filter: { repository: { allow: ["acme/app"] } } } })\n`

describe("process host presets", () => {
  it("detects a static import of a process host preset", () => {
    expect(usesProcessHostPreset(babysitterSource)).toBe(true)
    expect(usesProcessHostPreset(`import { babysitter } from '@vite-hub/agent/presets/babysitter'`)).toBe(true)
    expect(usesProcessHostPreset(`// import { babysitter } from "vite-hub/agent/presets/babysitter"\nexport default {}`)).toBe(false)
    expect(usesProcessHostPreset(`const preset = await import("vite-hub/agent/presets/babysitter")`)).toBe(false)
    expect(usesProcessHostPreset(`import { workspace } from "vite-hub/agent/presets/workspace"`)).toBe(false)
  })

  it("keeps the Babysitter host contribution through extends and options", () => {
    expect(getAgentProcessHostContribution(babysitter)).toBeDefined()
    const configured = defineAgent({ extends: babysitter, options: { concurrency: 2, filter: { repository: { allow: ["acme/app"] } }, mentionAllowlist: ["stefina"] } })
    expect(configured.options.mentionAllowlist).toEqual(["stefina"])
    expect(getAgentProcessHostContribution(configured)).toBe(getAgentProcessHostContribution(babysitter))
    expect(getAgentProcessHostContribution(defineAgent({ extends: configured, name: "child" }))).toBeDefined()
    expect(getAgentProcessHostContribution(defineAgent({ name: "plain", driver: { run: () => "" } }))).toBeUndefined()
    expect(() => defineAgent({ extends: babysitter, options: { concurrency: 0 } })).toThrow(/concurrency/)
  })
})

describe("createAgentProcessHosts", () => {
  function fakeHost(): AgentProcessHostInstance & { started: number, closed: number } {
    return {
      started: 0, closed: 0,
      start() { this.started++ },
      async close() { this.closed++ },
      wake() {},
      status: () => "accepting",
      health: async () => ({ status: "healthy" }),
    }
  }

  it("starts each contributed host with its own state scope and data directory", async () => {
    const host = fakeHost()
    const create = vi.fn(async () => host)
    const agent = withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create })
    const extension = vi.fn()
    const hosts = createAgentProcessHosts({ names: ["worker", "missing-host"], enabled: true, dataDir: "/data", registry: {
      "worker": async () => ({ default: agent }),
      "missing-host": async () => ({ default: defineAgent({ name: "missing-host", driver: { run: () => "" } }) }),
    }, state: () => ({ extension }) })
    hosts.start()
    await vi.waitFor(() => expect(host.started).toBe(1))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentName: "worker", dataDir: "/data/worker", state: { extension } }))
    expect(hosts.status()).toBe("accepting")
    expect(await hosts.health()).toEqual({ status: "degraded", agents: { "worker": { status: "healthy" }, "missing-host": { status: "degraded", reason: "The Agent has no process host contribution." } } })
    await hosts.close()
    expect(host.closed).toBe(1)
  })

  it("creates a host again after a failed start", async () => {
    const host = fakeHost()
    const create = vi.fn().mockRejectedValueOnce(new Error("GitHub App request /app failed with 503.")).mockResolvedValue(host)
    const hosts = createAgentProcessHosts({ names: ["worker"], enabled: true, retryMs: 5, registry: {
      worker: async () => ({ default: withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create }) }),
    }, state: () => ({ extension: vi.fn() }) })
    hosts.start()
    await vi.waitFor(() => expect(host.started).toBe(1))
    expect(create).toHaveBeenCalledTimes(2)
    expect(hosts.status()).toBe("accepting")
    expect((await hosts.health()).status).toBe("healthy")
    await hosts.close()
  })

  it("does not start outside production unless enabled", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("VITEHUB_AGENT_PROCESS_HOSTS", "")
    const create = vi.fn()
    const hosts = createAgentProcessHosts({ names: ["worker"], registry: { worker: async () => ({ default: withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create }) }) }, state: () => ({ extension: vi.fn() }) })
    hosts.start()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(create).not.toHaveBeenCalled()
    expect(hosts.status()).toBe("drained")
    expect((await hosts.health()).status).toBe("degraded")
  })
})

describe("Babysitter webhook intake", () => {
  const payload = JSON.stringify({ action: "opened", repository: { full_name: "acme/app" } })
  const request = (secret: string) => new Request("https://example.test/api/_vitehub/agents/babysitter/webhooks/github", {
    method: "POST",
    body: payload,
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
  })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn(), agentIdentity: { name: "babysitter" } }
  const input = { body: payload, payload: JSON.parse(payload), github: { deliveryId: "delivery-1", event: "pull_request" } }
  const agent = defineAgent({ extends: babysitter, name: "babysitter", options: { filter: { repository: { allow: ["acme/app"] } } } })

  it("passes a signed delivery to the running host without starting the Agent", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const intake = vi.fn(async () => Response.json({ accepted: true }, { status: 202 }))
    registerAgentProcessHostIntake("babysitter", intake)
    const invocation = await resolveAgentTriggerInvocation(agent, { ...runtime, request: request("webhook-secret") }, "github.delivery", input)
    expect("response" in invocation && invocation.response.status).toBe(202)
    expect(intake).toHaveBeenCalledWith({ deliveryId: "delivery-1", event: "pull_request", payload: JSON.parse(payload) })
  })

  it("rejects a wrong signature and fails closed without a webhook secret", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const intake = vi.fn()
    registerAgentProcessHostIntake("babysitter", intake)
    await expect(resolveAgentTriggerInvocation(agent, { ...runtime, request: request("wrong") }, "github.delivery", input)).rejects.toMatchObject({ statusCode: 401 })
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "")
    await expect(resolveAgentTriggerInvocation(agent, { ...runtime, request: request("") }, "github.delivery", input)).rejects.toThrow()
    expect(intake).not.toHaveBeenCalled()
  })

  it("reports 503 while the host has not started", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const invocation = await resolveAgentTriggerInvocation(agent, { ...runtime, request: request("webhook-secret") }, "github.delivery", input)
    expect("response" in invocation && invocation.response.status).toBe(503)
  })
})

describe("generated process hosts", () => {
  async function project(source: string) {
    const root = await mkdtemp(join(tmpdir(), "vitehub-process-hosts-"))
    roots.push(root)
    await mkdir(join(root, "server", "agents", "babysitter"), { recursive: true })
    await writeFile(join(root, "server", "agents", "babysitter", "agent.ts"), source, "utf8")
    return root
  }

  it("writes the host entry, plugin, and routes for a Babysitter Agent on Node", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(babysitterSource)
    const plugin = hubAgent({ providers: { state: { provider: "libsql", journalMode: "delete", url: "file:state.sqlite" } } })
    if (!isRuntimeFunction(plugin.configResolved)) throw new TypeError("Expected Agent configResolved hook.")
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    const entry = await readFile(join(root, ".vitehub/agent/process-hosts.ts"), "utf8")
    expect(entry).toContain('import registry from "#vitehub/agent/registry"')
    expect(entry).toContain('createAgentProcessHosts({ names: ["babysitter"], registry, state: agentProcessHostState })')
    expect(await readFile(join(root, ".vitehub/agent/process-hosts-plugin.ts"), "utf8")).toContain("setTimeout(() => host.start(), 0)")
    expect(await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")).toContain("export const agentProcessHostState = () => chatStateFromLibsql()")
    expect(await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")).toContain('"journalMode":"delete"')

    // The extends form is discovered the same way.
    await writeFile(join(root, "server", "agents", "babysitter", "agent.ts"), babysitterSource.replace('preset: "babysitter", presets: { babysitter }', "extends: babysitter"), "utf8")
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    expect(await readFile(join(root, ".vitehub/agent/process-hosts.ts"), "utf8")).toContain('names: ["babysitter"]')

    await writeFile(join(root, "server", "agents", "babysitter", "agent.ts"), "export default {}", "utf8")
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    await expect(stat(join(root, ".vitehub/agent/process-hosts.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("registers the plugin and host routes, and rejects hosts that cannot run a process", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(babysitterSource)
    const config = (preset?: string) => {
      const plugin = hubAgent({ providers: { state: { provider: "libsql", url: "libsql://state.example.test" } } })
      if (!isRuntimeFunction(plugin.config)) throw new TypeError("Expected Agent config hook.")
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      const options = { root, ...(preset ? { preset } : {}), nitro: {} } as never
      plugin.config.call({} as never, options, { command: "build", mode: "production" } as never)
      return options as { nitro: { plugins?: string[], handlers?: { route: string }[] } }
    }
    const node = config()
    expect(node.nitro.plugins).toEqual(expect.arrayContaining([expect.stringContaining("process-hosts-plugin.ts")]))
    expect(node.nitro.handlers?.map(handler => handler.route)).toEqual(expect.arrayContaining(["/api/_vitehub/host/drain", "/api/_vitehub/host/health"]))
    expect(() => config("vercel")).toThrow(/AGENT_B0022|cannot run it/)
  })
})
