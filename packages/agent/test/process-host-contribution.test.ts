import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { env } from "@vite-hub/env"
import { defineAgent } from "../src/index.ts"
import { agentProcessHostIntake, registerAgentProcessHostIntake, withAgentProcessHost, type AgentProcessHostInstance } from "../src/process-host.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import { discoverProcessHostAgentNames, usesProcessHostPreset } from "../src/discovery.ts"
import { createAgentProcessHosts } from "../src/runtime/process.ts"
import { agentProcessHostLeaseIntervalMs, agentProcessHostLeaseKey, agentProcessHostLeaseTtlMs } from "../src/runtime/process-host-lease.ts"
import { createMemoryLeaseStore, createSqlLeaseStore, type Lease, type LeaseStore } from "@vite-hub/runtime"
import { DatabaseSync } from "node:sqlite"
import { resolveConfig } from "vite"
import { installStubPackages } from "./support/stub-packages.ts"

const roots: string[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const workerSource = `import { defineAgent } from "vite-hub/agent"\nimport { worker } from "@acme/host/worker"\nexport default defineAgent({ extends: worker })\n`

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

  it("ignores an import that only brings types from a process host subpath", async () => {
    const file = join(await hostPackageRoot("vitehub-process-host-types-"), "server", "agents", "worker.ts")
    expect(usesProcessHostPreset(`import type { WorkerOptions } from "@acme/host/worker"`, file)).toBe(false)
    expect(usesProcessHostPreset(`import { type WorkerOptions } from "@acme/host/worker"`, file)).toBe(false)
    expect(usesProcessHostPreset(`export type { WorkerOptions } from "@acme/host/worker"`, file)).toBe(false)
    expect(usesProcessHostPreset(`import { type WorkerOptions, worker } from "@acme/host/worker"`, file)).toBe(true)
    expect(usesProcessHostPreset(`export { worker as default } from "@acme/host/worker"`, file)).toBe(true)
    expect(usesProcessHostPreset(`import "@acme/host/worker"`, file)).toBe(true)
  })

  it("finds a process host preset that an Agent reaches through relative imports", async () => {
    const root = await hostPackageRoot("vitehub-process-host-relative-")
    const files: Record<string, string> = {
      "server/agents/direct.ts": workerSource,
      "server/agents/shared.ts": `import { defineAgent } from "vite-hub/agent"\nimport { preset } from "../lib/preset"\nexport default defineAgent({ extends: preset })\n`,
      "server/agents/reexport.ts": `export { default } from "./direct.ts"\n`,
      "server/agents/types.ts": `import { defineAgent } from "vite-hub/agent"\nimport type { Preset } from "../lib/preset"\nexport default defineAgent({ name: "types" })\nexport type Local = Preset\n`,
      "server/agents/plain.ts": `import { defineAgent } from "vite-hub/agent"\nimport { label } from "../lib/cycle-a"\nimport notes from "../lib/notes.json"\nexport default defineAgent({ name: label + notes.length })\n`,
      "server/lib/preset.ts": `import { worker } from "@acme/host/worker"\nexport const preset = worker\nexport type Preset = typeof worker\n`,
      "server/lib/cycle-a.ts": `import { other } from "./cycle-b"\nexport const label = "plain" + other\n`,
      "server/lib/cycle-b.ts": `import { label } from "./cycle-a"\nexport const other = String(label)\n`,
      "server/lib/notes.json": `[]`,
    }
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await mkdir(join(root, "server", "lib"), { recursive: true })
    await Promise.all(Object.entries(files).map(([path, source]) => writeFile(join(root, path), source)))
    const definitions = ["direct", "shared", "reexport", "types", "plain"].map(name => ({ name, handler: join(root, "server", "agents", `${name}.ts`) }))
    const config = await resolveConfig({ root, configFile: false, envDir: false }, "build")
    await expect(discoverProcessHostAgentNames(definitions, config.createResolver())).resolves.toEqual(["direct", "reexport", "shared"])
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

  it.each([false, true])("reports a host as starting until its Agent has loaded (Lease: %s)", async (leased) => {
    const host = fakeHost()
    const loaded = deferred<void>()
    const loading = deferred<void>()
    const leases = createMemoryLeaseStore()
    const agent = withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create: async () => host })
    const hosts = createAgentProcessHosts({ names: ["worker"], enabled: true, leases: leased ? () => leases : undefined, registry: {
      worker: async () => {
        loading.resolve()
        await loaded.promise
        return { default: agent }
      },
    }, state: () => ({ extension: vi.fn() }) })
    hosts.start()
    await loading.promise
    try {
      expect(await hosts.health()).toEqual({ status: "degraded", agents: { worker: { status: "degraded", reason: "Process host is starting." } } })
    }
    finally {
      loaded.resolve()
      await vi.waitFor(() => expect(host.started).toBe(1))
      expect(await hosts.health()).toEqual({ status: "healthy", agents: { worker: { status: "healthy", ...(leased ? { role: "holder" } : {}) } } })
      await hosts.close()
    }
    if (!leased) expect(await hosts.health()).toEqual({ status: "healthy", agents: {} })
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

describe("createAgentProcessHosts with a Lease", () => {
  const lease = { ttlMs: 200, intervalMs: 20 }
  function fakeHost(): AgentProcessHostInstance & { running: boolean } {
    return {
      running: false,
      start() { this.running = true },
      async close() { this.running = false },
      wake() {},
      status: () => "accepting",
      health: async () => ({ status: "healthy" }),
    }
  }
  function server(leases: LeaseStore, create: () => Promise<AgentProcessHostInstance>) {
    return createAgentProcessHosts({ names: ["worker"], enabled: true, lease, leases: () => leases, registry: {
      worker: async () => ({ default: withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create }) }),
    }, state: () => ({ extension: vi.fn() }) })
  }

  it("runs the host on one server at a time and hands it over when the holder stops", async () => {
    const leases = createMemoryLeaseStore()
    const [first, second] = [fakeHost(), fakeHost()]
    const [a, b] = [server(leases, async () => first), server(leases, async () => second)]
    a.start()
    await vi.waitFor(() => expect(first.running).toBe(true))
    b.start()
    await new Promise(resolve => setTimeout(resolve, 5 * lease.intervalMs))
    expect(second.running).toBe(false)
    expect(b.status()).toBe("accepting")
    expect(await b.health()).toMatchObject({ status: "healthy", agents: { worker: { role: "standby" } } })
    expect(await a.health()).toMatchObject({ agents: { worker: { status: "healthy", role: "holder" } } })
    expect((await leases.get(agentProcessHostLeaseKey("worker")))[1]).toMatchObject({ key: "agent-process-host:worker" })

    const finishClose = deferred<void>()
    const closing = vi.spyOn(first, "close").mockImplementation(async () => {
      await finishClose.promise
      first.running = false
    })
    const stopped = a.close()
    try {
      await vi.waitFor(() => expect(closing).toHaveBeenCalled())
      await new Promise(resolve => setTimeout(resolve, 2 * lease.ttlMs))
      expect(second.running).toBe(false)
    }
    finally {
      finishClose.resolve()
      await stopped
      await vi.waitFor(() => expect(second.running).toBe(true))
      await b.close()
    }
    expect(first.running).toBe(false)
    expect(second.running).toBe(false)
  })

  it.each(["starting", "running"])("fences a %s host when renewal never answers", async (phase) => {
    const store = createMemoryLeaseStore()
    const renew = deferred<Awaited<ReturnType<Lease["renew"]>>>()
    const renewStarted = vi.fn(() => renew.promise)
    let acquiredOnce = false
    const leases: LeaseStore = { ...store, async acquire(key, options) {
      if (acquiredOnce) return [undefined, null]
      const [error, acquired] = await store.acquire(key, options)
      acquiredOnce = Boolean(acquired)
      return error ? [error, undefined] : [undefined, acquired && { ...acquired, renew: renewStarted }]
    } }
    const host = fakeHost()
    const start = vi.spyOn(host, "start")
    const close = vi.spyOn(host, "close")
    const startup = deferred<AgentProcessHostInstance>()
    const create = vi.fn(() => startup.promise)
    const first = server(leases, create)
    const peerHost = fakeHost()
    const peer = server(store, async () => peerHost)
    if (phase === "running") startup.resolve(host)
    first.start()
    try {
      await vi.waitFor(() => expect(create).toHaveBeenCalled())
      await vi.waitFor(() => expect(renewStarted).toHaveBeenCalled())
      peer.start()
      await vi.waitFor(() => expect(peerHost.running).toBe(true))
      expect(host.running).toBe(false)
      startup.resolve(host)
      await vi.waitFor(() => expect(close).toHaveBeenCalled())
      expect(start).toHaveBeenCalledTimes(phase === "running" ? 1 : 0)
    }
    finally {
      startup.resolve(host)
      renew.resolve([undefined, true])
      await Promise.all([first.close(), peer.close()])
    }
  })

  it("stops the host before the Lease expires when the holder cannot renew it", async () => {
    const database = new DatabaseSync(":memory:")
    let renewals = true
    const leases = createSqlLeaseStore({ dialect: "sqlite", query: async (text, params) => {
      if (!renewals && /^\s*update/i.test(text)) throw new Error("Database unavailable")
      const statement = database.prepare(text)
      return /^\s*(select|with)|returning/i.test(text) ? statement.all(...params) : (statement.run(...params), [])
    } })
    const host = fakeHost()
    let stoppedAt: number | undefined
    const hosts = server(leases, async () => ({ ...host, close: async () => { stoppedAt ??= performance.now() } }))
    hosts.start()
    await vi.waitFor(async () => expect(await hosts.health()).toMatchObject({ agents: { worker: { role: "holder" } } }))
    await new Promise(resolve => setTimeout(resolve, 3 * lease.intervalMs))
    renewals = false
    const failedAt = performance.now()
    await vi.waitFor(() => expect(stoppedAt).toBeDefined())
    expect(stoppedAt! - failedAt).toBeLessThan(lease.ttlMs)
    await hosts.close()
  })

  it("frees the Lease when the host does not start, so another server can run it", async () => {
    const leases = createMemoryLeaseStore()
    const host = fakeHost()
    const failing = vi.fn(async () => { throw new Error("GitHub App request /app failed with 503.") })
    const a = server(leases, failing)
    a.start()
    await vi.waitFor(async () => expect(await a.health()).toMatchObject({ status: "degraded", agents: { worker: { reason: expect.stringContaining("GitHub App") } } }))
    expect(a.status()).toBe("failed")
    const b = server(leases, async () => host)
    b.start()
    await vi.waitFor(() => expect(host.running).toBe(true))
    await vi.waitFor(async () => expect(await a.health()).toMatchObject({ status: "healthy", agents: { worker: { role: "standby", holder: expect.any(String) } } }))
    await Promise.all([a.close(), b.close()])
  })

  it("keeps webhook deliveries on a standby server and hands them to the holder", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-process-host-forward-"))
    roots.push(root)
    const state = createLibsqlAgentState({ url: `file:${join(root, "state.db")}` })
    const leases = createMemoryLeaseStore()
    const [, other] = await leases.acquire(agentProcessHostLeaseKey("worker"), { owner: "other-server", ttl: 60 })
    const handled: string[] = []
    const finishDelivery = deferred<void>()
    const finishClose = deferred<void>()
    const closeStarted = deferred<void>()
    const host = { ...fakeHost(), start() {
      registerAgentProcessHostIntake("worker", async ({ deliveryId }) => {
        handled.push(deliveryId)
        await finishDelivery.promise
        return new Response(null, { status: 202 })
      })
    }, async close() {
      registerAgentProcessHostIntake("worker", undefined)
      closeStarted.resolve()
      await finishClose.promise
    } }
    const hosts = createAgentProcessHosts({ names: ["worker"], enabled: true, lease, leases: () => leases, registry: {
      worker: async () => ({ default: withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create: async () => host }) }),
    }, state: () => state })
    hosts.start()
    await vi.waitFor(async () => expect(await hosts.health()).toMatchObject({ agents: { worker: { role: "standby", holder: "other-server" } } }))
    for (const deliveryId of ["delivery-1", "delivery-2", "delivery-1"]) {
      const response = await agentProcessHostIntake("worker")!({ deliveryId, event: "pull_request", payload: { number: 7 } })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: true, forwarded: true })
    }
    expect(handled).toEqual([])
    await other!.release()
    try {
      await vi.waitFor(() => expect(handled).toEqual(["delivery-1"]))
      await new Promise(resolve => setTimeout(resolve, 2 * lease.ttlMs))
      expect((await leases.get(agentProcessHostLeaseKey("worker")))[1]).toBeDefined()
      finishDelivery.resolve()
      await vi.waitFor(() => expect(handled).toEqual(["delivery-1", "delivery-2"]))
      const queued = () => state.extension("process_host").execute("SELECT delivery_id FROM vitehub_agent_state_process_host_intake")
      await vi.waitFor(async () => expect(await queued()).toEqual([]))
      void hosts.close()
      await closeStarted.promise
      const response = await agentProcessHostIntake("worker")?.({ deliveryId: "during-close", event: "pull_request", payload: { number: 7 } })
      expect(response?.status).toBe(202)
      expect(await queued()).toEqual([{ delivery_id: "during-close" }])
    }
    finally {
      finishDelivery.resolve()
      finishClose.resolve()
      await hosts.close()
      await state.disconnect()
    }
    expect(agentProcessHostIntake("worker")).toBeUndefined()
  })

  it("runs the host on every server when no Lease store exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const host = fakeHost()
    const hosts = createAgentProcessHosts({ names: ["worker"], enabled: true, leases: () => { throw new Error("No Database") }, registry: {
      worker: async () => ({ default: withAgentProcessHost(defineAgent({ name: "worker", driver: { run: () => "" } }), { create: async () => host }) }),
    }, state: () => ({ extension: vi.fn() }) })
    hosts.start()
    await vi.waitFor(() => expect(host.running).toBe(true))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("need a Lease store"), expect.any(Error))
    await hosts.close()
  })

  it("replaces a stopped holder within about 30 seconds by default", () => {
    expect(agentProcessHostLeaseTtlMs + agentProcessHostLeaseIntervalMs).toBe(30_000)
  })
})

describe("generated process hosts", () => {
  async function project(source: string) {
    const root = await hostPackageRoot("vitehub-process-hosts-")
    await mkdir(join(root, "server", "agents", "worker"), { recursive: true })
    await writeFile(join(root, "server", "agents", "worker", "agent.ts"), source, "utf8")
    return root
  }

  it.each([undefined, "../../lib/preset.js", "../../lib/presets"])("writes the host entry, plugin, and routes on Node (%s)", async (specifier) => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(specifier ? `export { default } from ${JSON.stringify(specifier)}` : workerSource)
    const directory = join(root, "server", "lib")
    await mkdir(join(directory, "presets"), { recursive: true })
    await writeFile(join(directory, "preset.ts"), workerSource)
    await writeFile(join(directory, "presets", "index.ts"), workerSource)
    const plugin = hubAgent({ providers: { state: { driver: "libsql", journalMode: "delete", url: "file:state.sqlite" } } })
    if (typeof plugin.config !== "function" || typeof plugin.configResolved !== "function") throw new TypeError("Expected Agent config hooks.")
    const config = { command: "build", mode: "production", root, nitro: {} }
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    await plugin.config.call({} as never, config, { command: "build", mode: "production" })
    expect(config.nitro).toMatchObject({ handlers: expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/host/health" })]) })
    await plugin.configResolved.call({} as never, config as never)
    const entry = await readFile(join(root, ".vitehub/agent/process-hosts.ts"), "utf8")
    expect(entry).toContain('import registry from "#vitehub/agent/registry"')
    expect(entry).toContain('createAgentProcessHosts({ names: ["worker"], registry, state: agentProcessHostState })')
    expect(await readFile(join(root, ".vitehub/agent/process-hosts-plugin.ts"), "utf8")).toContain("setTimeout(() => host.start(), 0)")
    expect(await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")).toContain("export const agentProcessHostState = () => chatStateFromLibsql()")
    expect(await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")).toContain('"journalMode":"delete"')
    // The drain and health routes are Fetchables. Run them with a stub host.
    const host = { health: async () => ({ agents: {}, status: "healthy" }), status: () => "accepting" }
    for (const [file, body] of [["process-hosts-drain.ts", { status: "accepting" }], ["process-hosts-health.ts", { agents: {}, status: "healthy" }]] as const) {
      const source = await readFile(join(root, ".vitehub/agent", file), "utf8")
      expect(source).not.toContain("h3")
      const route = new Function("host", source.replace(/^import .*\n/gm, "").replace("export default ", "return "))(host) as { fetch: () => Response | Promise<Response> }
      const response = await route.fetch()
      expect(response.headers.get("content-type")).toBe("application/json")
      await expect(response.json()).resolves.toEqual(body)
    }

    await writeFile(join(root, "server", "agents", "worker", "agent.ts"), "export default {}", "utf8")
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    await expect(stat(join(root, ".vitehub/agent/process-hosts.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reads a declared State auth token from its env variable at runtime", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(workerSource)
    const authToken = env({ secret: true, source: env.source("TURSO_AUTH_TOKEN") })
    const plugin = hubAgent({ providers: { state: { driver: "libsql", authToken, url: "libsql://state.example.test" } } })
    if (typeof plugin.configResolved !== "function") throw new TypeError("Expected Agent configResolved hook.")
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    await plugin.configResolved.call({} as never, { command: "build", root } as never)
    const route = await readFile(join(root, ".vitehub/agent/chat-webhook-route.ts"), "utf8")
    expect(route).toContain(`(process.env["TURSO_AUTH_TOKEN"]) ? { authToken: process.env["TURSO_AUTH_TOKEN"] } : {}`)
    expect(route).not.toContain("authToken\":")
  })

  it("generates separate process host and recovery Lease loaders with a Database", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(workerSource)
    await installStubPackages(root, ["@vite-hub/database/runtime/registry"])
    const plugin = hubAgent({ providers: { state: { driver: "libsql", url: "file:state.sqlite" } } })
    if (typeof plugin.config !== "function" || typeof plugin.configResolved !== "function") throw new TypeError("Expected Agent config hooks.")
    const config = { command: "build", root, nitro: {}, resolve: { alias: [] }, plugins: [{ name: "nitro:main" }, { name: "@vite-hub/database/vite" }] }
    await plugin.config.call({} as never, config as never, { command: "build", mode: "production" })
    await plugin.configResolved.call({} as never, config as never)
    await expect(readFile(join(root, ".vitehub/agent/process-hosts.ts"), "utf8")).resolves.toContain("leases: agentProcessHostLeases")
    await expect(readFile(join(root, ".vitehub/agent/webhook-queue-plugin.ts"), "utf8")).resolves.toContain("resumeWebhookQueues(waitUntil, recoverInterruptedBefore, agentRecoveryLeases())")
  })

  it("registers the plugin and host routes, and rejects hosts that cannot run a process", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const root = await project(workerSource)
    const config = async (preset?: string) => {
      const plugin = hubAgent({ providers: { state: { driver: "libsql", url: "libsql://state.example.test" } } })
      if (typeof plugin.config !== "function") throw new TypeError("Expected Agent config hook.")
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      const options = { root, ...(preset ? { vitehub: { host: preset } } : {}), nitro: {} } as never
      await plugin.config.call({} as never, options, { command: "build", mode: "production" } as never)
      return options as { nitro: { plugins?: string[], handlers?: { route: string }[] } }
    }
    const node = await config()
    expect(node.nitro.plugins).toEqual(expect.arrayContaining([expect.stringContaining("process-hosts-plugin.ts")]))
    expect(node.nitro.handlers?.map(handler => handler.route)).toEqual(expect.arrayContaining(["/_vitehub/host/drain", "/_vitehub/host/health"]))
    await expect(config("vercel")).rejects.toThrow(/AGENT_B0022|cannot run it/)

    const directory = join(root, "server", "agents", "worker")
    const agent = join(directory, "agent.ts")
    await writeFile(join(directory, "barrel.ts"), `export { worker as preset, worker as default } from "@acme/host/worker"; export const name = "worker"`)
    await writeFile(join(directory, "winner.ts"), `export { worker as preset } from "@acme/host/worker"`)
    await writeFile(join(directory, "winner.js"), `export const preset = "worker"`)
    for (const [imported, specifier] of [["name", "./barrel"], ["preset", "./winner.js"], ["default", "./barrel.ts?raw"]]) {
      await writeFile(agent, `import { ${imported} as name } from "${specifier}"; export default defineAgent({ name })`)
      await expect(config("vercel")).resolves.toBeDefined()
    }
    await writeFile(agent, `import { preset } from "./barrel"; export default defineAgent({ extends: preset })`)
    await expect(config("vercel")).rejects.toThrow(/AGENT_B0022|cannot run it/)
  })
})
