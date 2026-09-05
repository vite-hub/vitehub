import { access, readFile } from "node:fs/promises"
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
  context: createAgentInvocationContextStore(), purpose: "inspection",
})
const ready = () => ({
  enabled: true, installed: true, status: "ready", version: "1", checkedAt: new Date().toISOString(),
  auth: { status: "authenticated" }, usageLimits: { checkedAt: new Date().toISOString(), windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 25 }] },
})
afterEach(() => vi.resetAllMocks())

describe("provider inspection", () => {
  it("resolves invocation credentials and environment, without starting a session, then removes temporary credentials", async () => {
    let home = ""
    inspectProvider.mockImplementation(async options => {
      home = options.settings.homePath
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "synthetic-key" })
      expect(options.environment.GH_TOKEN).toBe("synthetic-token")
      return ready()
    })
    const credentials = vi.fn((_context: unknown) => JSON.stringify({ OPENAI_API_KEY: "synthetic-key" }))
    const result = await inspectAgentProvider({ provider: "codex", credentials, env: () => ({ GH_TOKEN: "synthetic-token" }) }, context())
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

  it("uses and cleans the configured launcher for Claude too", async () => {
    let launcher = ""
    inspectProvider.mockImplementation(async options => {
      launcher = options.settings.binaryPath
      expect(await readFile(join(dirname(launcher), "provider-launcher.mjs"), "utf8")).toContain("capsule")
      return ready()
    })
    const launch = vi.fn((_context: unknown) => ({ command: "capsule", args: ["--", "claude"] }))
    await inspectAgentProvider({ provider: "claude-code", launch }, context())
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ purpose: "inspection", requiredEnvironment: [] })
    await expect(access(launcher)).rejects.toThrow()
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
