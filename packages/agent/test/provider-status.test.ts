import { execFileSync } from "node:child_process"
import * as childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return { ...original, spawn: vi.fn(original.spawn) }
})

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
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("provider inspection", () => {
  it("groups identical credentials without disclosing them and caches only that scope", async () => {
    inspectProvider.mockResolvedValue(ready())
    const options = { provider: "codex" as const, credentials: '{"OPENAI_API_KEY":"fake-same-account"}' }
    const first = await inspectAgentProvider(options, context())
    const second = await inspectAgentProvider(options, { ...context(), agentIdentity: { name: "other" } })
    const preflight = await inspectAgentProvider(options, context(), { checkRequirements: false })
    expect(preflight.account).toEqual(first.account)
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

  it("reports Driver commands that are missing where the Driver runs", async () => {
    inspectProvider.mockResolvedValue(ready())
    const requirements = ["sh", "vitehub-missing-command-a", "vitehub-missing-command-b"]

    const local = await inspectAgentProvider({ provider: "codex", requirements }, context())
    expect(local).toMatchObject({
      missingCommands: ["vitehub-missing-command-a", "vitehub-missing-command-b"],
      readiness: "unavailable",
      reason: "Driver commands are missing: vitehub-missing-command-a, vitehub-missing-command-b.",
    })

    // The launcher receives the check command, as it would for an SSH runner.
    const launch = vi.fn(({ command }: { command: string }) => ({ command, args: [] }))
    inspectProvider.mockImplementation(async options => {
      execFileSync(options.settings.binaryPath, ["-e", ""], { stdio: "pipe" })
      return ready()
    })
    const launched = await inspectAgentProvider({ provider: "codex", providerSettings: { binaryPath: process.execPath }, launch, requirements: ["sh"] }, context())
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ command: "sh" }))
    expect(launched).toMatchObject({ missingCommands: [], readiness: "ready" })

    inspectProvider.mockResolvedValue(ready())
    const unchecked = await inspectAgentProvider({ provider: "codex" }, context())
    expect(unchecked).not.toHaveProperty("missingCommands")
  })

  it("selects one launcher target for requirements and the provider probe", async () => {
    let selections = 0
    const launch = vi.fn(({ command }: { command: string }) => ({
      command: ++selections === 1 ? "sh" : "vitehub-wrong-runner",
      args: ["-c", 'exec "$@"', "runner-a", command],
    }))
    inspectProvider.mockImplementation(async options => {
      expect(execFileSync(options.settings.binaryPath, ["-e", 'process.stdout.write("same-runner")'], { encoding: "utf8" })).toBe("same-runner")
      return ready()
    })

    const status = await inspectAgentProvider({ provider: "codex", providerSettings: { binaryPath: process.execPath }, launch, requirements: ["sh"] }, context())
    expect(launch).toHaveBeenCalledOnce()
    expect(status).toMatchObject({ missingCommands: [], readiness: "ready" })
  })

  it("routes shell inspection by provider identity while preserving wrapper arguments", async () => {
    const launch = vi.fn(({ command, providerCommand }: { command: string, providerCommand: string }) => ({
      command: providerCommand === process.execPath ? "sh" : "vitehub-wrong-provider-runner",
      args: ["-c", 'exec "$@"', "provider-runner", command],
    }))
    inspectProvider.mockImplementation(async options => {
      expect(execFileSync(options.settings.binaryPath, ["-e", 'process.stdout.write("provider-runner")'], { encoding: "utf8" })).toBe("provider-runner")
      return ready()
    })

    const status = await inspectAgentProvider({ provider: "codex", providerSettings: { binaryPath: process.execPath }, launch, requirements: ["sh"] }, context())
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ command: "sh", providerCommand: process.execPath }))
    expect(status).toMatchObject({ missingCommands: [], readiness: "ready" })
  })

  it("checks requirements inside the provider's single-use launcher execution", async () => {
    let executions = 0
    const launch = vi.fn(async ({ command, cwd }: { command: string, cwd: string }) => {
      const counter = join(cwd, "launcher-executions")
      const path = join(cwd, "single-use.mjs")
      await writeFile(path, `import { readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
let count = 0
try { count = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) } catch {}
writeFileSync(${JSON.stringify(counter)}, String(++count))
if (count > 1) process.exit(42)
const result = spawnSync(process.argv[2], process.argv.slice(3), { stdio: "inherit" })
process.exit(result.status ?? 1)
`)
      return { command: process.execPath, args: [path, command] }
    })
    inspectProvider.mockImplementation(async options => {
      expect(execFileSync(options.settings.binaryPath, ["-e", 'process.stdout.write("single-target")'], { encoding: "utf8" })).toBe("single-target")
      executions = Number(await readFile(join(dirname(options.settings.binaryPath), "launcher-executions"), "utf8"))
      return ready()
    })

    const status = await inspectAgentProvider({ provider: "codex", providerSettings: { binaryPath: process.execPath }, launch, requirements: ["sh", "vitehub-missing-single-use-command"] }, context())
    expect(status).toMatchObject({ missingCommands: ["vitehub-missing-single-use-command"], readiness: "unavailable" })
    expect(launch).toHaveBeenCalledOnce()
    expect(executions).toBe(1)
  })

  it("captures requirements for each provider probe without exposing frames in stderr", async () => {
    let root = ""
    const launch = vi.fn(({ command, cwd }: { command: string, cwd: string }) => {
      root = cwd
      return { command, args: [] }
    })
    inspectProvider.mockImplementation(async options => {
      const stderr = "provider warning\n" + "x".repeat(20_000)
      for (let probe = 0; probe < 2; probe++) {
        const result = childProcess.spawnSync(options.settings.binaryPath, ["-e", `process.stderr.write(${JSON.stringify(stderr)});process.stdout.write("provider output")`], { encoding: "utf8" })
        expect(result.status).toBe(0)
        expect(result.stdout).toBe("provider output")
        expect(result.stderr).toBe(stderr)
      }
      const path = join(root, "provider-requirements.jsonl")
      expect((await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([
        ["vitehub-missing-probe-command"], ["vitehub-missing-probe-command"],
      ])
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      return ready()
    })

    const status = await inspectAgentProvider({ provider: "codex", providerSettings: { binaryPath: process.execPath }, launch, requirements: ["sh", "vitehub-missing-probe-command"] }, context())
    expect(status).toMatchObject({ missingCommands: ["vitehub-missing-probe-command"], readiness: "unavailable" })
    expect(launch).toHaveBeenCalledOnce()
    await expect(access(root)).rejects.toThrow()
  })

  it.each(["wrapper warning", "x".repeat(20_000)])("captures requirements after unterminated wrapper stderr", async warning => {
    const launch = ({ command }: { command: string }) => ({
      command: "sh",
      args: ["-c", 'printf "%s" "$1" >&2; shift; exec "$@"', "wrapper", warning, command],
    })
    inspectProvider.mockImplementation(async options => {
      const result = childProcess.spawnSync(options.settings.binaryPath, ["-e", 'process.stdout.write("provider output")'], { encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe("provider output")
      expect(result.stderr).toBe(warning)
      return ready()
    })

    const status = await inspectAgentProvider({ provider: "codex", providerSettings: { binaryPath: process.execPath }, launch, requirements: ["sh", "vitehub-missing-fragment-command"] }, context())
    expect(status).toMatchObject({ missingCommands: ["vitehub-missing-fragment-command"], readiness: "unavailable" })
  })

  it("keeps requirement readiness unknown when the launcher produces no frame", async () => {
    inspectProvider.mockResolvedValue(ready())
    const status = await inspectAgentProvider({ provider: "codex", launch: () => ({ command: "sh" }), requirements: ["sh"] }, context())
    expect(status).toMatchObject({ readiness: "unknown", reason: "Driver requirements could not be verified." })
    expect(status).not.toHaveProperty("missingCommands")
  })

  it("redacts exact Driver environment values from requirement failures", async () => {
    const secret = "bare-private-driver-value"
    const launch = () => ({ command: process.execPath, args: ["-e", 'process.stderr.write(process.env.DRIVER_SECRET);process.exit(1)', "--"] })
    inspectProvider.mockImplementation(async options => {
      expect(() => execFileSync(options.settings.binaryPath, [], { env: options.environment, stdio: "pipe" })).toThrow()
      const diagnostic = await readFile(join(dirname(options.settings.binaryPath), "provider-launch-failure.json"), "utf8")
      expect(diagnostic).toContain("[REDACTED]")
      expect(diagnostic).not.toContain(secret)
      return { ...ready(), status: "error" }
    })
    const status = await inspectAgentProvider({ provider: "codex", env: { DRIVER_SECRET: secret }, launch, requirements: ["sh"] }, context())
    expect(status.readiness).toBe("unavailable")
    expect(JSON.stringify(status)).not.toContain(secret)
  })

  it("returns missing Windows commands instead of rejecting status", async () => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }))
    const spawn = vi.mocked(childProcess.spawn).mockImplementation((_command, args) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => child.emit("close", args?.[0] === "missing" ? 1 : 0))
      // SAFETY: The lookup only uses these ChildProcess streams and lifecycle events.
      return child as never
    })
    inspectProvider.mockResolvedValue(ready())

    const status = await inspectAgentProvider({ provider: "codex", requirements: ["available", "missing"] }, context())
    expect(status).toMatchObject({ readiness: "unavailable", missingCommands: ["missing"] })
    expect(spawn.mock.calls.map(call => [call[0], call[1]])).toEqual([["where.exe", ["available"]], ["where.exe", ["missing"]]])
  })

  it("skips command probes for invocation preflight without caching them as checked", async () => {
    inspectProvider.mockResolvedValue(ready())
    const launch = vi.fn(({ command }: { command: string }) => ({ command, args: [] }))
    const options = { provider: "codex" as const, providerSettings: { binaryPath: process.execPath }, credentials: '{"OPENAI_API_KEY":"preflight-test-account"}', launch, requirements: ["vitehub-missing-command"] }
    const preflight = await inspectAgentProvider(options, context(), { checkRequirements: false })
    expect(preflight).not.toHaveProperty("missingCommands")
    expect(launch.mock.calls[0]?.[0].command).toBe(process.execPath)

    inspectProvider.mockImplementation(async options => {
      execFileSync(options.settings.binaryPath, ["-e", ""], { stdio: "pipe" })
      return ready()
    })
    const inspection = await inspectAgentProvider(options, context())
    expect(inspection).toMatchObject({ missingCommands: ["vitehub-missing-command"], readiness: "unavailable" })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]?.[0].command).toBe("sh")
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
  it("rejects unavailable capacity before starting capability preparation", async () => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    const prepare = vi.fn(() => { throw new Error("unexpected runtime installation") })
    const close = vi.fn()
    const agent = defineAgent({ runtime: false, driver: { kind: "codex", model: "test" }, capabilities: [defineCapability({
      id: "runtime-preparation", prepare, close,
    })] })
    const status = vi.spyOn(agent, "status").mockResolvedValue({
      agent: "test", checkedAt: new Date().toISOString(), readiness: "unavailable", stale: false, reason: "Workspace spend cap reached",
    })
    await expect(runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => void task.catch(() => {}) }, { prompt: "hello" }))
      .rejects.toMatchObject({ code: "AGENT_R0726", fix: expect.stringContaining("spending limit") })
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ checkRequirements: false }))
    expect(prepare).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("applies the provider deadline during capability preparation", async () => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    const prepare = vi.fn(async (context: { abortSignal?: AbortSignal }) => {
      const signal = context.abortSignal
      expect(signal).toBeInstanceOf(AbortSignal)
      if (!signal) throw new Error("Missing preparation deadline")
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    })
    const agent = defineAgent({ runtime: false, driver: { kind: "codex", model: "test" }, capabilities: [defineCapability({ id: "slow-runtime", prepare })] })
    vi.spyOn(agent, "status").mockResolvedValue({ agent: "test", readiness: "ready", checkedAt: new Date().toISOString(), stale: false })
    await expect(runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => void task.catch(() => {}) }, { prompt: "hello", timeout: 50 }))
      .rejects.toThrow(/timeout|timed out/i)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it.each(["ready", "unknown", "stale"])("continues preparation for %s provider evidence", async (evidence) => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    const prepare = vi.fn()
    const agent = defineAgent({ runtime: false, driver: { kind: "codex", model: "test" }, capabilities: [defineCapability({
      id: "handled-runtime", prepare, input: () => new Response("handled"),
    })] })
    const status = vi.spyOn(agent, "status").mockResolvedValue({
      agent: "test", checkedAt: new Date().toISOString(), readiness: evidence === "stale" ? "unavailable" : evidence === "ready" ? "ready" : "unknown", stale: evidence === "stale",
    })
    const result = await runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => void task.catch(() => {}) }, { prompt: "hello" })
    expect(await (result as Response).text()).toBe("handled")
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledTimes(1)
  })

  it("lets handled input respond without checking an unavailable provider", async () => {
    const { defineAgent, defineCapability, runAgentInline } = await import("../src/index.ts")
    const agent = defineAgent({ runtime: false, driver: { kind: "codex", model: "test" }, capabilities: [defineCapability({ id: "handled", input: () => new Response("handled") })] })
    const status = vi.spyOn(agent, "status").mockResolvedValue({ agent: "test", readiness: "unavailable", checkedAt: new Date().toISOString(), stale: false })
    const result = await runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => void task.catch(() => {}) }, { prompt: "hello" })
    expect(await (result as Response).text()).toBe("handled")
    expect(status).not.toHaveBeenCalled()
  })

  it("lets interception respond without checking an unavailable provider", async () => {
    const { defineAgent, runAgentInline } = await import("../src/index.ts")
    const agent = defineAgent({
      runtime: false,
      driver: { kind: "codex", model: "test" },
      intercept: () => "handled",
    })
    const status = vi.spyOn(agent, "status").mockResolvedValue({ agent: "test", readiness: "unavailable", checkedAt: new Date().toISOString(), stale: false })
    const result = await runAgentInline(agent, { runtime: "unknown", memo: (_key, create) => create(), waitUntil: task => void task.catch(() => {}) }, { prompt: "hello" })

    expect(result).toBe("handled")
    expect(status).not.toHaveBeenCalled()
  })
})
