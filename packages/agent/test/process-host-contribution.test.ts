import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAgent } from "../src/index.ts"
import { withAgentProcessHost, type AgentProcessHostInstance } from "../src/process-host.ts"
import { usesProcessHostPreset } from "../src/discovery.ts"
import { createAgentProcessHosts } from "../src/runtime/process.ts"
import { isRuntimeFunction } from "../src/internal/runtime-value.ts"

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const workerSource = `import { defineAgent } from "vite-hub/agent"\nimport { worker } from "@acme/host/worker"\nexport default defineAgent({ preset: "worker", presets: { worker } })\n`

/** A project with a package that declares `./worker` as a process host subpath in package.json. */
async function hostPackageRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  await mkdir(join(root, "node_modules", "@acme", "host"), { recursive: true })
  await writeFile(join(root, "node_modules", "@acme", "host", "package.json"), JSON.stringify({ name: "@acme/host", vitehub: { agent: { processHost: ["./worker"] } } }))
  return root
}

describe("process host presets", () => {
  it("detects a static import of a package subpath that declares a process host", async () => {
    const file = join(await hostPackageRoot("vitehub-process-host-traits-"), "server", "agents", "worker.ts")
    expect(usesProcessHostPreset(workerSource, file)).toBe(true)
    expect(usesProcessHostPreset(`import { worker } from '@acme/host/worker'`, file)).toBe(true)
    expect(usesProcessHostPreset(`// import { worker } from "@acme/host/worker"\nexport default {}`, file)).toBe(false)
    expect(usesProcessHostPreset(`const preset = await import("@acme/host/worker")`, file)).toBe(false)
    expect(usesProcessHostPreset(`import { other } from "@acme/host/other"`, file)).toBe(false)
    expect(usesProcessHostPreset(`import { worker } from "@acme/missing/worker"`, file)).toBe(false)
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

describe("generated process hosts", () => {
  async function project(source: string) {
    const root = await hostPackageRoot("vitehub-process-hosts-")
    await mkdir(join(root, "server", "agents", "worker"), { recursive: true })
    await writeFile(join(root, "server", "agents", "worker", "agent.ts"), source, "utf8")
    return root
  }

  it("writes the host entry, plugin, and routes for a process host Agent on Node", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(workerSource)
    const plugin = hubAgent({ providers: { state: { provider: "libsql", journalMode: "delete", url: "file:state.sqlite" } } })
    if (!isRuntimeFunction(plugin.configResolved)) throw new TypeError("Expected Agent configResolved hook.")
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    const entry = await readFile(join(root, ".vitehub/agent/process-hosts.ts"), "utf8")
    expect(entry).toContain('import registry from "#vitehub/agent/registry"')
    expect(entry).toContain('createAgentProcessHosts({ names: ["worker"], registry, state: agentProcessHostState })')
    expect(await readFile(join(root, ".vitehub/agent/process-hosts-plugin.ts"), "utf8")).toContain("setTimeout(() => host.start(), 0)")
    expect(await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")).toContain("export const agentProcessHostState = () => chatStateFromLibsql()")
    expect(await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")).toContain('"journalMode":"delete"')

    // The extends form is discovered the same way.
    await writeFile(join(root, "server", "agents", "worker", "agent.ts"), workerSource.replace('preset: "worker", presets: { worker }', "extends: worker"), "utf8")
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    expect(await readFile(join(root, ".vitehub/agent/process-hosts.ts"), "utf8")).toContain('names: ["worker"]')

    await writeFile(join(root, "server", "agents", "worker", "agent.ts"), "export default {}", "utf8")
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    await expect(stat(join(root, ".vitehub/agent/process-hosts.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("registers the plugin and host routes, and rejects hosts that cannot run a process", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(workerSource)
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
