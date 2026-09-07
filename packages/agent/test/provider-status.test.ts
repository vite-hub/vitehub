import { execFileSync } from "node:child_process"
import { access, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const inspectProvider = vi.hoisted(() => vi.fn())
vi.mock("@t3tools/provider-runtime", () => ({ inspectProvider, createProviderRuntime: vi.fn(), createSqliteProviderRuntimeSessionStore: vi.fn() }))
vi.mock("../src/internal/provider-runtime-packages.ts", () => ({ resolveInstalledProviderExecutable: () => "/fake/codex" }))

import { inspectAgentProvider } from "../src/provider-agent.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import type { AgentProviderCredentialContext } from "../src/types.ts"

const context = (): AgentProviderCredentialContext => ({
  runtime: "unknown", capabilities: {}, agentIdentity: { name: "bot" },
  memo: (_key, create) => create(), waitUntil: () => undefined,
  context: createAgentInvocationContextStore(), purpose: "inspection",
})
const ready = () => ({
  enabled: true, installed: true, status: "ready", version: "1", checkedAt: new Date().toISOString(),
  auth: { status: "authenticated" }, usageLimits: { checkedAt: new Date().toISOString(), windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 25 }] },
})
afterEach(() => vi.resetAllMocks())

describe("provider inspection", () => {
  it("groups identical credentials without disclosing them and caches only that scope", async () => {
    inspectProvider.mockResolvedValue(ready())
    const options = { provider: "codex" as const, credentials: '{"OPENAI_API_KEY":"fake-same-account"}' }
    const first = await inspectAgentProvider(options, context())
    const second = await inspectAgentProvider(options, { ...context(), agentIdentity: { name: "other" } })
    expect(second.account).toEqual(first.account)
    expect(second.agent).toBe("other")
    expect(JSON.stringify(second)).not.toContain("fake-same-account")
    expect(inspectProvider).toHaveBeenCalledTimes(1)
    const different = await inspectAgentProvider({ ...options, credentials: '{"OPENAI_API_KEY":"another"}' }, context())
    expect(different.account?.id).not.toBe(first.account?.id)
  })

  it("resolves invocation credentials and environment, without starting a session, then removes temporary credentials", async () => {
    let home = ""
    inspectProvider.mockImplementation(async options => {
      home = options.settings.homePath
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "synthetic-key" })
      expect(options.environment.GH_TOKEN).toBe("synthetic-token")
      return ready()
    })
    const credentials = vi.fn((_context: unknown) => JSON.stringify({ OPENAI_API_KEY: "synthetic-key" }))
    const launch = vi.fn(() => ({ command: process.execPath }))
    const result = await inspectAgentProvider({ provider: "codex", credentials, launch, env: () => ({ GH_TOKEN: "synthetic-token" }) }, context())
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ requiredEnvironment: ["CODEX_HOME"] }))
    expect(credentials.mock.calls[0]?.[0]).toMatchObject({ purpose: "inspection" })
    expect(result).toMatchObject({ agent: "bot", readiness: "ready", authenticated: true, stale: false })
    expect(JSON.stringify(result)).not.toContain("synthetic")
    await expect(access(home)).rejects.toThrow()
  })

  it.each([
    ["signed out", { auth: { status: "unauthenticated" } }, "unavailable"],
    ["missing executable", { installed: false }, "unavailable"],
    ["exhausted", { usageLimits: { checkedAt: new Date().toISOString(), windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }] } }, "unavailable"],
    ["unsupported quota", { usageLimits: { checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: "unsupported" } } }, "unknown"],
    ["failed quota", { usageLimits: { checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: "probeFailed", message: "secret diagnostic" } } }, "unknown"],
  ])("represents %s honestly", async (_, override, readiness) => {
    inspectProvider.mockResolvedValue({ ...ready(), ...override })
    const result = await inspectAgentProvider({ provider: "codex" }, context())
    expect(result.readiness).toBe(readiness)
    expect(JSON.stringify(result)).not.toContain("secret diagnostic")
  })

  it("uses the configured launcher from its resolved working directory, then cleans it", async () => {
    let launcher = ""
    let cwd = ""
    inspectProvider.mockImplementation(async options => {
      launcher = options.settings.binaryPath
      expect(await readFile(join(dirname(launcher), "provider-launcher.mjs"), "utf8")).toContain(process.execPath)
      expect(execFileSync(launcher, { encoding: "utf8" })).toBe(cwd)
      return ready()
    })
    const launch = vi.fn((launchContext: { cwd: string }) => {
      cwd = launchContext.cwd
      return { command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }
    })
    await inspectAgentProvider({ provider: "claude-code", launch }, context())
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ purpose: "inspection", requiredEnvironment: [] })
    await expect(access(launcher)).rejects.toThrow()
  })

  it.each(["env", "launch"] as const)("cleans inspection resources when a stalled %s resolver ignores cancellation", async (stage) => {
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let root = ""
    const before = new Set(await readdir(tmpdir()))
    const stalled = () => { entered(); return new Promise<never>(() => {}) }
    const probe = inspectAgentProvider({
      provider: "codex", credentials: '{"OPENAI_API_KEY":"stalled-resolver"}',
      ...(stage === "env" ? { env: stalled } : { launch: (value: { cwd: string }) => { root = value.cwd; return stalled() } }),
    }, { ...context(), abortSignal: controller.signal })
    const rejected = expect(probe).rejects.toThrow("inspection cancelled")
    await started
    const allocated = (await readdir(tmpdir())).filter(name => !before.has(name) && (name.startsWith("vitehub-codex-process-") || name.startsWith("vitehub-provider-inspection-")))
    expect(allocated.length).toBeGreaterThan(0)
    controller.abort(new Error("inspection cancelled"))
    await rejected
    for (const name of allocated) await expect(access(join(tmpdir(), name))).rejects.toThrow()
    if (root) await expect(access(root)).rejects.toThrow()
    expect(inspectProvider).not.toHaveBeenCalled()
  })

  it("settles a cancelled credential resolver and ignores its late result", async () => {
    const controller = new AbortController()
    let resolveCredentials!: (value: string) => void
    const credentials = new Promise<string>(resolve => { resolveCredentials = resolve })
    const env = vi.fn(() => ({}))
    const probe = inspectAgentProvider({ provider: "codex", credentials: () => credentials, env }, { ...context(), abortSignal: controller.signal })
    const rejected = expect(probe).rejects.toThrow("inspection cancelled")
    controller.abort(new Error("inspection cancelled"))
    await rejected
    resolveCredentials('{"OPENAI_API_KEY":"late-credentials"}')
    await credentials
    await Promise.resolve()
    expect(env).not.toHaveBeenCalled()
    expect(inspectProvider).not.toHaveBeenCalled()
  })

  it("forwards cancellation and cleans credentials when the probe fails", async () => {
    const controller = new AbortController()
    let home = ""
    inspectProvider.mockImplementation(async options => {
      home = options.settings.homePath
      expect(options.signal).toBe(controller.signal)
      controller.abort(new Error("cancelled"))
      throw options.signal.reason
    })
    await expect(inspectAgentProvider({ provider: "codex", credentials: '{"OPENAI_API_KEY":"fake"}' }, { ...context(), abortSignal: controller.signal })).rejects.toThrow("cancelled")
    await expect(access(home)).rejects.toThrow()
  })
})

describe("invocation preflight", () => {
  it("rejects known unavailable capacity while preparation is still pending, then closes late resources", async () => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    let release!: () => void
    let prepared!: () => void
    const started = new Promise<void>(resolve => { prepared = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const close = vi.fn()
    const background: Promise<unknown>[] = []
    const agent = defineAgent({ runtime: false, driver: { kind: "codex", model: "test" }, capabilities: [defineCapability({
      id: "slow-preparation", async prepare() { prepared(); await gate }, close,
      input() { return new Response("handled") },
    })] })
    vi.spyOn(agent, "status").mockImplementation(async () => {
      await started
      return { agent: "test", checkedAt: new Date().toISOString(), readiness: "unavailable", stale: false, reason: "Workspace spend cap reached" }
    })
    const run = runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => { background.push(task) } }, { prompt: "hello" })
    try { await expect(run).rejects.toMatchObject({ code: "AGENT_R0726", fix: expect.stringContaining("spending limit") }) }
    finally { release() }
    await Promise.allSettled(background)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("allows unknown readiness and never starts a model probe", async () => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    const agent = defineAgent({ runtime: false, driver: { kind: "codex", model: "test" }, capabilities: [defineCapability({ id: "handled", input: () => new Response("handled") })] })
    const status = vi.spyOn(agent, "status").mockResolvedValue({ agent: "test", readiness: "unknown", checkedAt: new Date().toISOString(), stale: false })
    const result = await runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => void task.catch(() => {}) }, { prompt: "hello" })
    expect(await (result as Response).text()).toBe("handled")
    expect(status).toHaveBeenCalledTimes(1)
  })
})
