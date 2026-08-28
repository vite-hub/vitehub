import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createTraceEventLog, traceEventsToOpenTelemetrySpans } from "@vite-hub/runtime"

// SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: {
  environment?: Record<string, string>
  settings?: Record<string, unknown>
}) => providerRuntimes.shift()))
const resolveInstalledCodexExecutable = vi.hoisted(() => vi.fn<() => string | undefined>(() => "/app/node_modules/@openai/codex/bin/codex.js"))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime }))
vi.mock("../src/internal/codex-runtime-package.ts", () => ({ resolveInstalledCodexExecutable }))

import { createProviderAgentAdapter, localWorkspaceHost } from "../src/provider-agent.ts"
import { codexDriver, defineAgent, runAgent } from "../src/index.ts"
import { readAgentWorkspaceDiff } from "../src/agent-workspace-runtime.ts"
import { agentInvocationInputSupport, sendAgentInvocationInput } from "../src/internal/agent-invocation-control.ts"
import { withAgentInvocationResponseOwner } from "../src/internal/agent-invocation-response-owner.ts"
import { markAuxiliaryMessageChannelInstructionContext } from "../src/internal/channels.ts"
import { getAgentTelemetryConfiguration, setAgentTelemetryConfiguration } from "../src/internal/agent-telemetry.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { finalizeUiMessageStreamOutput } from "../src/stream-output.ts"
import { applyAgentToolPolicies, withAgentToolStepReporting, withJsonCompatibleToolOutputs } from "../src/tool-runtime.ts"

function event(type: string, threadId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { payload, threadId, type, ...extra }
}

function runtime(threadId: string, events: unknown[], options: {
  afterEvents?: () => Promise<void>
  onSendTurn?: (mcp: { authorizationHeader: string, endpoint: string } | undefined) => Promise<void>
  onStartSession?: () => Promise<void>
  beforeEvent?: (index: number) => Promise<void>
  resumeCursor?: string
  turnResumeCursor?: string
} = {}) {
  let mcp: { authorizationHeader: string, endpoint: string } | undefined
  const value = {
    attachmentsDirectory: `/tmp/attachments-${crypto.randomUUID()}`,
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        for (const [index, event] of events.entries()) {
          await options.beforeEvent?.(index)
          yield event
        }
        await options.afterEvents?.()
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => {
      await options.onSendTurn?.(mcp)
      return { resumeCursor: options.turnResumeCursor, threadId, turnId: "turn-1" }
    }),
    startSession: vi.fn(async (input: { mcp?: typeof mcp }) => {
      await options.onStartSession?.()
      mcp = input.mcp
      return { resumeCursor: options.resumeCursor, threadId }
    }),
    stopSession: vi.fn(async () => undefined),
  }
  providerRuntimes.push(value)
  return value
}

function context(threadId: string, overrides: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>()
  return {
    actor: { id: "actor" },
    context: {
      entries: () => values.entries(),
      get: (key: string) => values.get(key),
      has: (key: string) => values.has(key),
      set: (key: string, value: unknown) => values.set(key, value),
      toJSON: () => Object.fromEntries(values),
    },
    input: { prompt: "hello" },
    invoker: { id: "invoker", kind: "user" },
    messages: [],
    prompt: "hello",
    runtime: {
      memo: <T>(_key: string, create: () => T) => create(),
      run: { runId: `run-${threadId}`, threadId },
      runtime: "vite",
      runtimeConfig: {},
      waitUntil: () => undefined,
    },
    ...overrides,
  }
}

async function collect(value: unknown) {
  const events = []
  // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
  for await (const item of value as AsyncIterable<unknown>) events.push(item)
  return events
}

describe("Provider Agent Driver", () => {
  it("passes only host process essentials and explicitly selected environment values", async () => {
    const threadId = "thread-environment"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    vi.stubEnv("VITEHUB_UNRELATED_SECRET", "do-not-expose")
    const adapter = createProviderAgentAdapter({ env: { PROVIDER_SELECTED: "selected" }, provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId) as never)

    expect(createProviderRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ PROVIDER_SELECTED: "selected" }),
      settings: { binaryPath: "/app/node_modules/@openai/codex/bin/codex.js" },
    }))
    expect(createProviderRuntime).toHaveBeenCalled()
    const lastRuntimeCall = createProviderRuntime.mock.lastCall
    expect(lastRuntimeCall).toBeDefined()
    expect(lastRuntimeCall?.[0].environment).not.toHaveProperty("VITEHUB_UNRELATED_SECRET")
    expect(provider.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ modelOptions: expect.anything() }))
    vi.unstubAllEnvs()
  })

  it("keeps the host Codex executable fallback when the package is absent", async () => {
    const threadId = "thread-host-codex"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    resolveInstalledCodexExecutable.mockReturnValueOnce(undefined)

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId) as never)

    expect(createProviderRuntime).toHaveBeenLastCalledWith(expect.not.objectContaining({ settings: expect.anything() }))
  })

  it("keeps the installed Codex executable when provider setting overrides are undefined", async () => {
    const threadId = "thread-undefined-provider-settings"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const providerContext = context(threadId) as never
    await createProviderAgentAdapter({
      provider: "codex",
      providerSettings: { binaryPath: undefined, launchArgs: undefined },
    }).generate(providerContext)

    expect(createProviderRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      settings: { binaryPath: "/app/node_modules/@openai/codex/bin/codex.js" },
    }))
  })

  it("isolates resolved Codex credentials in a private shadow home and removes it after runtime shutdown", async () => {
    const threadId = "thread-credentials"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    await writeFile(join(sharedHome, "config.toml"), "model = \"gpt-5.6-sol\"\n")
    let shadowHome: string | undefined
    createProviderRuntime.mockImplementationOnce(async (options) => {
      expect(options.settings?.homePath).toEqual(expect.any(String))
      shadowHome = String(options.settings?.homePath)
      expect(options.settings).toMatchObject({
        binaryPath: "/custom/codex",
        homePath: expect.stringContaining("vitehub-codex-shadow-home-"),
        launchArgs: "--enable responses_websockets_v2",
      })
      expect(options.settings).not.toHaveProperty("shadowHomePath")
      expect((await lstat(shadowHome)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(shadowHome, "auth.json"))).mode & 0o777).toBe(0o600)
      expect((await lstat(join(shadowHome, "auth.json"))).isSymbolicLink()).toBe(false)
      expect(await readFile(join(shadowHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"secret"}}\n')
      expect(await readlink(join(shadowHome, "sessions"))).toBe(join(sharedHome, "sessions"))
      expect(await readlink(join(shadowHome, "config.toml"))).toBe(join(sharedHome, "config.toml"))
      return providerRuntimes.shift()
    })
    const credentials = vi.fn(async (metadata: { actor: { id: string } }) => {
      expect(metadata.actor.id).toBe("actor")
      return { unseal: () => '{ "tokens": { "access_token": "secret" } }' }
    })

    const adapter = createProviderAgentAdapter({
      credentials,
      provider: "codex",
      providerSettings: {
        binaryPath: "/custom/codex",
        homePath: sharedHome,
        launchArgs: "--enable responses_websockets_v2",
      },
    })
    const runContext = context(threadId)
    // SAFETY: This test fixture intentionally constructs the exact provider run context.
    await adapter.generate(runContext as never)

    expect(credentials).toHaveBeenCalledOnce()
    expect(shadowHome).toBeDefined()
    if (!shadowHome) throw new Error("Expected a Codex shadow home")
    await expect(access(shadowHome)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(join(sharedHome, "sessions"))).resolves.toBeUndefined()
    await rm(sharedHome, { force: true, recursive: true })
  })

  it.each(["linux", "win32"] as const)("preserves Codex history through a private shadow home on %s", async (platformName) => {
    const threadId = `thread-history-${platformName}`
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    await writeFile(join(sharedHome, "config.toml"), "model = \"gpt-5.6-sol\"\n")
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue(platformName)
    createProviderRuntime.mockImplementationOnce(async (options) => {
      const shadowHome = String(options.settings?.homePath)
      await writeFile(join(shadowHome, "history.jsonl"), `${JSON.stringify({ session_id: threadId })}\n`)
      await writeFile(join(shadowHome, "config.toml"), "model_reasoning_effort = \"high\"\n", { flag: "a" })
      return providerRuntimes.shift()
    })

    try {
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
        providerSettings: { homePath: sharedHome },
      })
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      await adapter.generate(context(threadId) as never)

      expect(await readFile(join(sharedHome, "history.jsonl"), "utf8")).toBe(`${JSON.stringify({ session_id: threadId })}\n`)
      expect(await readFile(join(sharedHome, "config.toml"), "utf8")).toBe("model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"high\"\n")
    }
    finally {
      platform.mockRestore()
      await rm(sharedHome, { force: true, recursive: true })
    }
  })

  it.runIf(process.platform === "win32")("restricts Codex credential home ACLs on Windows", async () => {
    const threadId = "thread-windows-credential-acl"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    createProviderRuntime.mockImplementationOnce(async (options) => {
      const shadowHome = String(options.settings?.homePath)
      const script = String.raw`
$ErrorActionPreference = "Stop"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($path in @($env:VITEHUB_CODEX_CREDENTIAL_HOME, (Join-Path $env:VITEHUB_CODEX_CREDENTIAL_HOME "auth.json"))) {
  $entry = Get-Item -LiteralPath $path
  $security = $entry.GetAccessControl()
  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($owner.Value -ne $identity.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $identity.Value -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
    throw "Credential ACL is not restricted to the current principal: $path"
  }
}
`
      const command = Buffer.from(script, "utf16le").toString("base64")
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
        env: { ...process.env, VITEHUB_CODEX_CREDENTIAL_HOME: shadowHome },
        encoding: "utf8",
        windowsHide: true,
      })
      expect(result.status, result.stderr || result.stdout).toBe(0)
      return providerRuntimes.shift()
    })

    // SAFETY: This test fixture intentionally constructs the exact provider run context.
    await createProviderAgentAdapter({
      credentials: '{"tokens":{"access_token":"secret"}}',
      provider: "codex",
    }).generate(context(threadId) as never)
  }, 15_000)

  it("uses CODEX_HOME as the shared Codex home", async () => {
    const threadId = "thread-environment-codex-home"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-environment-home-"))
    await writeFile(join(sharedHome, "config.toml"), "model = \"gpt-5.6-sol\"\n")
    createProviderRuntime.mockImplementationOnce(async (options) => {
      const shadowHome = String(options.settings?.homePath)
      expect(await readFile(join(shadowHome, "config.toml"), "utf8")).toBe("model = \"gpt-5.6-sol\"\n")
      return providerRuntimes.shift()
    })

    try {
      await createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        env: { CODEX_HOME: sharedHome },
        provider: "codex",
      }).generate(context(threadId) as never)
    }
    finally {
      await rm(sharedHome, { force: true, recursive: true })
    }
  })

  it("excludes private Codex home entries case-insensitively on macOS", async () => {
    const threadId = "thread-macos-credentials"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    await writeFile(join(sharedHome, "config.toml"), "model = \"gpt-5.6-sol\"\n")
    await writeFile(join(sharedHome, "Auth.json"), "ambient credentials\n")
    await mkdir(join(sharedHome, "Sessions"))
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin")
    let shadowHome: string | undefined
    createProviderRuntime.mockImplementationOnce(async (options) => {
      shadowHome = String(options.settings?.homePath)
      const config = await lstat(join(shadowHome, "config.toml"))
      expect(config.isSymbolicLink()).toBe(true)
      expect(await readFile(join(shadowHome, "config.toml"), "utf8")).toBe("model = \"gpt-5.6-sol\"\n")
      expect(await readFile(join(shadowHome, "auth.json"), "utf8")).toBe('{"tokens":{"access_token":"secret"}}\n')
      await expect(access(join(shadowHome, "Auth.json"))).rejects.toMatchObject({ code: "ENOENT" })
      const sessionEntries = (await readdir(shadowHome)).filter(entry => entry.toLowerCase() === "sessions")
      expect(sessionEntries).toHaveLength(1)
      const sessionEntry = sessionEntries[0]!
      expect(await readlink(join(shadowHome, sessionEntry))).toBe(join(sharedHome, sessionEntry))
      return providerRuntimes.shift()
    })

    try {
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
        providerSettings: { homePath: sharedHome },
      })
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      await adapter.generate(context(threadId) as never)
    }
    finally {
      platform.mockRestore()
      await rm(sharedHome, { force: true, recursive: true })
    }

    expect(shadowHome).toBeDefined()
    if (!shadowHome) throw new Error("Expected a Codex shadow home")
    await expect(access(shadowHome)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.runIf(process.platform !== "win32")("ignores dangling links in the shared Codex home", async () => {
    const threadId = "thread-dangling-codex-home-link"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    await symlink(join(sharedHome, "missing-skill"), join(sharedHome, "stale-skill"))

    try {
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
        providerSettings: { homePath: sharedHome },
      })
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      await expect(adapter.generate(context(threadId) as never)).resolves.toBeDefined()
    }
    finally {
      await rm(sharedHome, { force: true, recursive: true })
    }
  })

  it.runIf(process.platform !== "win32")("replaces shared Codex home links without writing through them", async () => {
    const threadId = "thread-shared-codex-home-link"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    const externalHome = await mkdtemp(join(tmpdir(), "vitehub-codex-external-home-"))
    const externalConfig = join(externalHome, "config.toml")
    await writeFile(externalConfig, "external = true\n")
    await symlink(externalConfig, join(sharedHome, "config.toml"))
    createProviderRuntime.mockImplementationOnce(async (options) => {
      const shadowHome = String(options.settings?.homePath)
      await rm(join(shadowHome, "config.toml"))
      await writeFile(join(shadowHome, "config.toml"), "sandbox = true\n")
      return providerRuntimes.shift()
    })

    try {
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
        providerSettings: { homePath: sharedHome },
      })
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      await adapter.generate(context(threadId) as never)

      expect((await lstat(join(sharedHome, "config.toml"))).isFile()).toBe(true)
      expect(await readFile(join(sharedHome, "config.toml"), "utf8")).toBe("sandbox = true\n")
      expect(await readFile(externalConfig, "utf8")).toBe("external = true\n")
    }
    finally {
      await rm(sharedHome, { force: true, recursive: true })
      await rm(externalHome, { force: true, recursive: true })
    }
  })

  it("serializes credential overlays that share a Codex home", async () => {
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => releaseFirst = resolve)
    const first = runtime("thread-shared-home-first", [event("turn.completed", "thread-shared-home-first", { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => firstBlocked,
    })
    runtime("thread-shared-home-second", [event("turn.completed", "thread-shared-home-second", { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({
      credentials: '{"tokens":{"access_token":"secret"}}',
      provider: "codex",
      providerSettings: { homePath: sharedHome },
    })
    const runtimeCalls = createProviderRuntime.mock.calls.length

    try {
      // SAFETY: These fixtures intentionally construct the exact provider run context.
      const firstInvocation = adapter.generate(context("thread-shared-home-first") as never)
      await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
      const secondInvocation = adapter.generate(context("thread-shared-home-second") as never)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 1)

      releaseFirst()
      await expect(firstInvocation).resolves.toBeDefined()
      await expect(secondInvocation).resolves.toBeDefined()
      expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 2)
    }
    finally {
      releaseFirst()
      await rm(sharedHome, { force: true, recursive: true })
    }
  })

  it.runIf(process.platform !== "win32")("serializes symlink aliases for the same Codex home", async () => {
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    const aliasRoot = await mkdtemp(join(tmpdir(), "vitehub-codex-home-alias-"))
    const alias = join(aliasRoot, "codex")
    await symlink(sharedHome, alias)
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => releaseFirst = resolve)
    const first = runtime("thread-home-alias-first", [event("turn.completed", "thread-home-alias-first", { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => firstBlocked,
    })
    runtime("thread-home-alias-second", [event("turn.completed", "thread-home-alias-second", { state: "completed" }, { turnId: "turn-1" })])
    const runtimeCalls = createProviderRuntime.mock.calls.length

    try {
      const firstInvocation = createProviderAgentAdapter({ credentials: "{}", provider: "codex", providerSettings: { homePath: sharedHome } })
        .generate(context("thread-home-alias-first") as never)
      await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
      const secondInvocation = createProviderAgentAdapter({ credentials: "{}", provider: "codex", providerSettings: { homePath: alias } })
        .generate(context("thread-home-alias-second") as never)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 1)

      releaseFirst()
      await expect(firstInvocation).resolves.toBeDefined()
      await expect(secondInvocation).resolves.toBeDefined()
      expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 2)
    }
    finally {
      releaseFirst()
      await Promise.all([
        rm(sharedHome, { force: true, recursive: true }),
        rm(aliasRoot, { force: true, recursive: true }),
      ])
    }
  })

  it.runIf(process.platform === "darwin")("serializes case-equivalent Codex homes on macOS", async () => {
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    const equivalentHome = sharedHome.toUpperCase()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => releaseFirst = resolve)
    const first = runtime("thread-macos-home-first", [event("turn.completed", "thread-macos-home-first", { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => firstBlocked,
    })
    runtime("thread-macos-home-second", [event("turn.completed", "thread-macos-home-second", { state: "completed" }, { turnId: "turn-1" })])
    const firstAdapter = createProviderAgentAdapter({
      credentials: '{"tokens":{"access_token":"secret"}}',
      provider: "codex",
      providerSettings: { homePath: sharedHome },
    })
    const secondAdapter = createProviderAgentAdapter({
      credentials: '{"tokens":{"access_token":"secret"}}',
      provider: "codex",
      providerSettings: { homePath: equivalentHome },
    })
    const runtimeCalls = createProviderRuntime.mock.calls.length

    try {
      // SAFETY: These fixtures intentionally construct the exact provider run context.
      const firstInvocation = firstAdapter.generate(context("thread-macos-home-first") as never)
      await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
      const secondInvocation = secondAdapter.generate(context("thread-macos-home-second") as never)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 1)

      releaseFirst()
      await expect(firstInvocation).resolves.toBeDefined()
      await expect(secondInvocation).resolves.toBeDefined()
      expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 2)
    }
    finally {
      releaseFirst()
      await Promise.all([
        rm(sharedHome, { force: true, recursive: true }),
        rm(equivalentHome, { force: true, recursive: true }),
      ])
    }
  })

  it("passes Codex reasoning selections to provider session startup", async () => {
    const threadId = "thread-reasoning-options"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])

    const adapter = createProviderAgentAdapter({
      model: "gpt-5.6-sol",
      provider: "codex",
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    })
    const runContext = context(threadId)
    // SAFETY: This test fixture intentionally constructs the exact provider run context.
    await adapter.generate(runContext as never)

    expect(provider.startSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-sol",
      modelOptions: { reasoningEffort: "high", reasoningSummary: "detailed" },
    }))
  })

  it("rejects malformed Codex credentials before starting a provider runtime", async () => {
    const runtimeCalls = createProviderRuntime.mock.calls.length

    const adapter = createProviderAgentAdapter({
      credentials: "not-json",
      provider: "codex",
    })
    const runContext = context("thread-invalid-credentials")
    // SAFETY: This test fixture intentionally constructs the exact provider run context.
    await expect(adapter.generate(runContext as never)).rejects.toThrow("must be valid JSON")

    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls)
  })

  it("does not request another provider event after the turn completes", async () => {
    const threadId = "thread-terminal-event"
    let requestedAfterTerminal = false
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      afterEvents: async () => {
        requestedAfterTerminal = true
      },
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId) as never)

    expect(requestedAfterTerminal).toBe(false)
  })

  it.each([
    ["Codex omitted", "codex", undefined, "approval-required"],
    ["Codex ask", "codex", "ask", "approval-required"],
    ["Codex allow edits", "codex", "allow-edits", "auto-accept-edits"],
    ["Codex allow all", "codex", "allow-all", "full-access"],
    ["Claude Code omitted", "claude-code", undefined, "approval-required"],
    ["Claude Code ask", "claude-code", "ask", "approval-required"],
    ["Claude Code allow edits", "claude-code", "allow-edits", "auto-accept-edits"],
    ["Claude Code allow all", "claude-code", "allow-all", "full-access"],
  ] as const)("maps %s to its provider runtime mode", async (_label, providerName, permissions, runtimeMode) => {
    const threadId = `thread-permissions-${providerName}-${permissions ?? "omitted"}`
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const providerOptions: { permissions?: typeof permissions, provider: typeof providerName } = { provider: providerName }
    if (permissions) providerOptions.permissions = permissions
    const adapter = createProviderAgentAdapter(providerOptions)

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId) as never)

    expect(provider.startSession).toHaveBeenCalledWith(expect.objectContaining({ runtimeMode, threadId }))
  })

  it("keeps provider session state for the lifetime of an Agent Definition", async () => {
    const agent = defineAgent({ driver: "codex", runtime: false })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(agent.resolve(context("thread-definition") as never)).resolves.toBe(
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      await agent.resolve(context("thread-definition") as never),
    )
  })

  it("maps normalized provider events and closes every runtime", async () => {
    const threadId = "thread-events"
    const provider = runtime(threadId, [
      event("session.started", threadId, { provider: "codex" }),
      event("content.delta", threadId, { delta: "thinking", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("item.started", threadId, { data: { command: "pwd" }, itemType: "command_execution", title: "shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("item.completed", threadId, { data: { stdout: "/tmp" }, itemType: "command_execution", status: "completed", title: "shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("request.opened", threadId, { args: { command: "rm" }, detail: "Needs approval", requestType: "command" }, { requestId: "request-1", turnId: "turn-1" }),
      event("user-input.requested", threadId, { questions: [{ id: "scope" }] }, { requestId: "input-1", turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "done", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("thread.token-usage.updated", threadId, { usage: { inputTokens: 3, outputTokens: 2, totalProcessedTokens: 5 } }),
      event("turn.completed", threadId, { state: "completed", stopReason: "end_turn" }, { turnId: "turn-1" }),
    ])
    const adapter = createProviderAgentAdapter({ permissions: "ask", provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const events = await collect(await adapter.stream!(context(threadId) as never)) as Array<Record<string, unknown>>

    expect(events.map(item => item.type)).toEqual([
      "data-agent-event",
      "text-delta",
      "tool-call",
      "tool-result",
      "approval-request",
      "data-agent-input",
      "text-delta",
      "usage",
      "finish",
    ])
    expect(events[1]).toMatchObject({ phase: "commentary", text: "thinking" })
    expect(events[6]).toMatchObject({ phase: "final", text: "done" })
    expect(events[7]).toMatchObject({ usageRecord: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } })
    expect(provider.startSession).toHaveBeenCalledWith(expect.objectContaining({ runtimeMode: "approval-required", threadId }))
    expect(provider.close).toHaveBeenCalledOnce()
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const cwd = (createProviderRuntime.mock.calls.at(-1)![0] as { cwd: string }).cwd
    await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves Capability action annotations from provider-native tool items", async () => {
    const threadId = "thread-actions"
    runtime(threadId, [
      event("item.started", threadId, { data: { item: { tool: "repository_host_write" } }, itemType: "mcp_tool_call" }, { itemId: "action-1", turnId: "turn-1" }),
      event("item.completed", threadId, { data: { item: { tool: "repository_host_write" } }, itemType: "mcp_tool_call", status: "completed" }, { itemId: "action-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const events = await collect(await adapter.stream!(context(threadId, {
      tools: {
        repository_host_write: {
          activity: { kind: "action", name: "repository-host.write" },
          execute: vi.fn(),
          name: "repository_host_write",
        },
      },
    }) as never)) as Array<Record<string, unknown>>

    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({ activity: { kind: "action", name: "repository-host.write" }, name: "repository_host_write", type: "tool-call" }),
      expect.objectContaining({ activity: { kind: "action", name: "repository-host.write" }, name: "repository_host_write", type: "tool-result" }),
    ])
  })

  it("preserves MCP tool identity, duration, and failures in invocation traces", async () => {
    const threadId = "thread-mcp-trace"
    const runId = "run-mcp-trace"
    runtime(threadId, [
      event("item.started", threadId, {
        data: { item: { arguments: { query: "purchase orders" }, server: "airtable", tool: "search_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        title: "airtable · search_records",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("item.started", threadId, {
        data: { item: { arguments: { query: "purchase orders" }, server: "airtable", tool: "search_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("item.completed", threadId, {
        data: { item: { durationMs: 42, result: { content: [{ text: "12 records", type: "text" }] }, server: "airtable", status: "completed", tool: "search_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        status: "completed",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("item.started", threadId, {
        data: { item: { arguments: { query: "errors" }, server: "posthog", tool: "query", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        title: "posthog · query",
      }, { itemId: "mcp-2", turnId: "turn-1" }),
      event("item.completed", threadId, {
        data: { item: { durationMs: 17, error: { message: "Access denied" }, server: "posthog", status: "failed", tool: "query", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        status: "completed",
        title: "posthog · query",
      }, { itemId: "mcp-2", turnId: "turn-1" }),
      event("item.started", threadId, {
        data: { item: { arguments: { table: "orders" }, server: "airtable", tool: "list_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        title: " ",
      }, { itemId: "mcp-3", turnId: "turn-1" }),
      event("item.completed", threadId, {
        data: { item: { durationMs: 9, result: { content: "2 records" }, server: "airtable", status: "completed", tool: "list_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        status: "completed",
        title: " ",
      }, { itemId: "mcp-3", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const invocations = defineAgentInvocations({
      content: "content",
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({ driver: codexDriver(), invocations, runtime: false })

    await runAgent(agent, {
      memo: <T>(_key: string, create: () => T) => create(),
      run: { runId, threadId },
      runtime: "vite",
      waitUntil: vi.fn(),
    }, { prompt: "inspect MCP calls" })

    const observations = (await invocations.getByRunId(runId))?.observations ?? []
    expect(observations.filter(observation => observation.name.startsWith("agent.tool"))).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.input": { query: "purchase orders" },
          "tool.name": "search_records",
          "tool.title": "airtable · search_records",
        }),
        name: "agent.tool.start",
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.input": { query: "purchase orders" },
          "tool.name": "search_records",
        }),
        name: "agent.tool.start",
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.durationMs": 42,
          "tool.name": "search_records",
        }),
        name: "agent.tool.finish",
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.input": { query: "errors" },
          "tool.name": "query",
          "tool.title": "posthog · query",
        }),
        name: "agent.tool.start",
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.durationMs": 17,
          "tool.error": "Access denied",
          "tool.name": "query",
          "tool.title": "posthog · query",
        }),
        name: "agent.tool.error",
        type: "error",
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.input": { table: "orders" },
          "tool.name": "list_records",
        }),
        name: "agent.tool.start",
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "tool.durationMs": 9,
          "tool.name": "list_records",
        }),
        name: "agent.tool.finish",
      }),
    ])
    const firstToolObservations = observations.filter(observation => observation.attributes?.["tool.id"] === "mcp-1")
    expect(firstToolObservations).toHaveLength(3)
    expect(firstToolObservations[0]?.attributes).toHaveProperty("tool.title", "airtable · search_records")
    expect(firstToolObservations.slice(1).every(observation => !("tool.title" in (observation.attributes ?? {})))).toBe(true)
    expect(observations.filter(observation => observation.attributes?.["tool.id"] === "mcp-3").every(observation => !("tool.title" in (observation.attributes ?? {})))).toBe(true)
    expect(observations.find(observation => observation.name === "agent.tool.error")?.attributes).not.toHaveProperty("tool.output")
  })

  it("preserves MCP titles through streamed provider output", async () => {
    const threadId = "thread-streamed-mcp-title"
    runtime(threadId, [
      event("item.started", threadId, {
        data: { item: { arguments: { query: "purchase orders" }, tool: "search_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        title: "airtable · search_records",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("item.completed", threadId, {
        data: { item: { result: { content: "12 records" }, status: "completed", tool: "search_records", type: "mcpToolCall" } },
        itemType: "mcp_tool_call",
        status: "completed",
        title: "airtable · search_records",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const events = await collect(await createProviderAgentAdapter({ provider: "codex" }).stream!(context(threadId) as never))

    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({ title: "airtable · search_records", type: "tool-call" }),
      expect.objectContaining({ title: "airtable · search_records", type: "tool-result" }),
    ])
  })

  it("preserves Claude MCP tool inputs and results without a generic title", async () => {
    const threadId = "thread-claude-mcp-trace"
    runtime(threadId, [
      event("item.started", threadId, {
        data: { input: { query: "purchase orders" }, toolName: "mcp__airtable__search_records" },
        itemType: "mcp_tool_call",
        title: "MCP tool call",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("item.completed", threadId, {
        data: { input: { query: "purchase orders" }, result: { content: "12 records" }, toolName: "mcp__airtable__search_records" },
        itemType: "mcp_tool_call",
        status: "completed",
        title: "MCP tool call",
      }, { itemId: "mcp-1", turnId: "turn-1" }),
      event("item.started", threadId, {
        data: { input: { query: "denied" }, toolName: "mcp__airtable__search_records" },
        itemType: "mcp_tool_call",
        title: "MCP tool call",
      }, { itemId: "mcp-2", turnId: "turn-1" }),
      event("item.completed", threadId, {
        data: {
          input: { query: "denied" },
          result: { content: [{ text: "Access denied", type: "text" }], is_error: true, type: "tool_result" },
          toolName: "mcp__airtable__search_records",
        },
        detail: "mcp__airtable__search_records: {\"query\":\"denied\"}",
        itemType: "mcp_tool_call",
        status: "failed",
        title: "MCP tool call",
      }, { itemId: "mcp-2", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const events = await collect(await createProviderAgentAdapter({ provider: "claude-code" }).stream!(context(threadId) as never)) as Array<Record<string, unknown>>

    expect(events.slice(0, 2)).toEqual([
      expect.objectContaining({ input: { query: "purchase orders" }, name: "mcp__airtable__search_records", type: "tool-call" }),
      expect.objectContaining({ name: "mcp__airtable__search_records", output: { content: "12 records" }, type: "tool-result" }),
    ])
    expect(events.slice(2, 4)).toEqual([
      expect.objectContaining({ input: { query: "denied" }, type: "tool-call" }),
      expect.objectContaining({ error: "Access denied", type: "tool-result" }),
    ])
    expect(events.slice(0, 4).every(event => !("title" in event))).toBe(true)
  })

  it("traces provider-native activity during generated runs", async () => {
    const threadId = "thread-generate-trace"
    runtime(threadId, [
      event("content.delta", threadId, { delta: "Inspecting ", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "files", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("turn.plan.updated", threadId, { explanation: "Inspect first", plan: [{ status: "inProgress", step: "Read files" }] }, { turnId: "turn-1" }),
      event("item.started", threadId, { data: { command: "git status" }, itemType: "command_execution", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "working\r", streamKind: "command_output" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "\u001B[2Kdone\n", streamKind: "command_output" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("tool.progress", threadId, { summary: "Checking status", toolName: "Shell", toolUseId: "tool-1" }, { turnId: "turn-1" }),
      event("item.completed", threadId, { data: { output: "clean" }, itemType: "command_execution", status: "completed", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("turn.diff.updated", threadId, { unifiedDiff: "diff --git a/a b/a" }, { turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "Done", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const traceLog = createTraceEventLog({ content: "content" })
    const runContext = context(threadId)
    setAgentTelemetryConfiguration(runContext.context, { driver: { kind: "provider" }, runtime: { name: "vite" } })
    const adapter = createProviderAgentAdapter({ instructions: "System instructions", provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate({ ...runContext, runtime: { ...runContext.runtime, traceLog } } as never)

    expect(traceLog.entries().map(entry => entry.name)).toEqual([
      "agent.message.delta",
      "agent.plan.updated",
      "agent.tool.start",
      "agent.tool.output",
      "agent.tool.progress",
      "agent.tool.finish",
      "agent.change.updated",
      "agent.message.delta",
      "agent.stream.finish",
    ])
    expect(traceLog.entries()[0]?.attributes?.["message.content"]).toBe("Inspecting files")
    expect(traceLog.entries().find(entry => entry.name === "agent.tool.output")?.attributes).toMatchObject({
      "step.id": "tool-1",
      "tool.id": "tool-1",
      "tool.output": "working\r\u001B[2Kdone\n",
      "vitehub.activity.body": "working\r\u001B[2Kdone\n",
      "vitehub.activity.kind": "tool",
    })
    expect(traceLog.entries().find(entry => entry.name === "agent.tool.progress")?.attributes?.["tool.output"]).toBe("Checking status")
    expect(getAgentTelemetryConfiguration(runContext.context)?.value).toMatchObject({
      driver: { kind: "provider", provider: "codex" },
      instructions: ["System instructions"],
    })
  })

  it("persists provider-native activity through a complete Agent invocation", async () => {
    const threadId = "thread-provider-invocation-trace"
    const runId = "run-provider-invocation-trace"
    runtime(threadId, [
      event("content.delta", threadId, { delta: "Inspecting", streamKind: "reasoning_text" }, { turnId: "turn-1" }),
      event("item.started", threadId, { data: { command: "git status" }, itemType: "command_execution", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("item.completed", threadId, { data: { output: "clean" }, itemType: "command_execution", status: "completed", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
      event("content.delta", threadId, { delta: "Done", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const invocations = defineAgentInvocations({
      content: "content",
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: codexDriver(),
      invocations,
      runtime: false,
    })

    await runAgent(agent, {
      memo: <T>(_key: string, create: () => T) => create(),
      run: { runId, threadId },
      runtime: "vite",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })

    const invocation = await invocations.getByRunId(runId)
    expect(invocation?.observations.map(observation => observation.name)).toEqual(expect.arrayContaining([
      "agent.message.delta",
      "agent.tool.start",
      "agent.tool.finish",
      "agent.message.delta",
      "agent.stream.finish",
    ]))
  })

  it.each([
    {
      events: (threadId: string) => [
        event("item.started", threadId, { data: { command: "pnpm test" }, itemType: "command_execution", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
        event("content.delta", threadId, { delta: "failed output\n", streamKind: "command_output" }, { itemId: "tool-1", turnId: "turn-1" }),
        event("item.completed", threadId, { detail: "Command failed", itemType: "command_execution", status: "failed", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
        event("turn.completed", threadId, { errorMessage: "Command failed", state: "failed" }, { turnId: "turn-1" }),
      ],
      name: "failed",
    },
    {
      events: (threadId: string) => [
        event("item.started", threadId, { data: { command: "pnpm test --watch" }, itemType: "command_execution", title: "Shell" }, { itemId: "tool-1", turnId: "turn-1" }),
        event("content.delta", threadId, { delta: "watch output\n", streamKind: "command_output" }, { itemId: "tool-1", turnId: "turn-1" }),
        event("turn.aborted", threadId, { reason: "cancelled" }, { turnId: "turn-1" }),
      ],
      name: "aborted",
    },
  ])("keeps command output correlated when a Provider turn is $name", async ({ events }) => {
    const threadId = `thread-command-${crypto.randomUUID()}`
    runtime(threadId, events(threadId))
    const traceLog = createTraceEventLog({ content: "content" })
    const runContext = context(threadId)

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(createProviderAgentAdapter({ provider: "codex" }).generate({
      ...runContext,
      runtime: { ...runContext.runtime, traceLog },
    } as never)).rejects.toThrow()

    const tool = traceEventsToOpenTelemetrySpans(traceLog.entries(), { content: "content" })
      .find(span => span.attributes?.["vitehub.step.id"] === "tool-1")
    expect(tool).toMatchObject({
      attributes: { "gen_ai.tool.call.id": "tool-1", "tool.id": "tool-1" },
      status: { code: "ERROR" },
    })
    expect(tool?.events?.map(item => item.name)).toContain("agent.tool.output")
  })

  it("preserves failed and cancelled Provider task outcomes in traces", async () => {
    const threadId = "thread-task-outcomes"
    runtime(threadId, [
      event("task.completed", threadId, { status: "failed", summary: "subagent failed", taskId: "task-1" }, { turnId: "turn-1" }),
      event("task.completed", threadId, { status: "stopped", taskId: "task-2" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const traceLog = createTraceEventLog({ content: "content" })
    const runContext = context(threadId)

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate({
      ...runContext,
      runtime: { ...runContext.runtime, traceLog },
    } as never)

    expect(traceLog.entries()).toMatchObject([
      {
        attributes: { "error.message": "subagent failed", "task.status": "failed" },
        name: "agent.task.failed",
        type: "error",
      },
      {
        attributes: { "task.status": "stopped" },
        name: "agent.task.cancelled",
        type: "run",
      },
      { name: "agent.stream.finish" },
    ])
  })

  it("continues a thread with the previous provider cursor", async () => {
    const threadId = "thread-resume"
    const first = runtime(threadId, [
      event("content.delta", threadId, { delta: "one", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ], { resumeCursor: "session-1", turnResumeCursor: "turn-1-cursor" })
    const second = runtime(threadId, [
      event("content.delta", threadId, { delta: "two", streamKind: "assistant_text" }, { turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const adapter = createProviderAgentAdapter({ model: "gpt-5.6-codex", provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId) as never)).resolves.toMatchObject({ text: "one" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, { input: { prompt: "continue" }, prompt: "continue" }) as never)).resolves.toMatchObject({ text: "two" })

    expect(first.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: "hello", threadId }))
    expect(second.startSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-codex", resumeCursor: "turn-1-cursor", threadId }))
  })

  it("clears a provider cursor when the invocation fails", async () => {
    const threadId = "thread-failed-resume"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "successful-cursor",
    })
    runtime(threadId, [event("turn.completed", threadId, { errorMessage: "provider failed", state: "failed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "failed-cursor",
    })
    const recovered = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId) as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId) as never)).rejects.toThrow("provider failed")
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId) as never)

    expect(recovered.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
  })

  it("partitions provider cursors by the resolved Chat Session", async () => {
    const threadId = "thread-chat-sessions"
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "session-a-cursor" })
    const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "session-b-cursor" })
    const resumed = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const sessionContext = (sessionId: string) => {
      const value = context(threadId)
      value.context.set("chat.sessionId", `${threadId}:chat-session:${sessionId}`)
      return value
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(sessionContext("a") as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(sessionContext("b") as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(sessionContext("a") as never)

    expect(first.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
    expect(second.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
    expect(resumed.startSession).toHaveBeenCalledWith(expect.objectContaining({ resumeCursor: "session-a-cursor" }))
  })

  it("partitions provider cursors by invoker kind", async () => {
    const threadId = "thread-invoker-kind"
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "user-cursor" })
    const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId, { invoker: { id: "shared", kind: "user" } }) as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId, { invoker: { id: "shared", kind: "service" } }) as never)

    expect(first.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
    expect(second.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
  })

  it("serializes concurrent invocations of the same provider thread", async () => {
    const threadId = "thread-concurrent"
    let releaseFirst!: () => void
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => new Promise<void>(resolve => releaseFirst = resolve),
      turnResumeCursor: "first-cursor",
    })
    const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const firstResult = adapter.generate(context(threadId) as never)
    await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const secondResult = adapter.generate(context(threadId) as never)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(second.startSession).not.toHaveBeenCalled()
    releaseFirst()

    await expect(Promise.all([firstResult, secondResult])).resolves.toHaveLength(2)
    expect(second.startSession).toHaveBeenCalledWith(expect.objectContaining({ resumeCursor: "first-cursor" }))
  })

  it("aborts while waiting for the same provider thread", async () => {
    const threadId = "thread-concurrent-abort"
    let releaseFirst!: () => void
    const first = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      beforeEvent: () => new Promise<void>(resolve => releaseFirst = resolve),
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const firstResult = adapter.generate(context(threadId) as never)
    await vi.waitFor(() => expect(first.sendTurn).toHaveBeenCalledOnce())
    const runtimeCount = createProviderRuntime.mock.calls.length

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, { input: { prompt: "queued", timeout: 10 } }) as never)).rejects.toThrow()
    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCount)
    releaseFirst()
    await expect(firstResult).resolves.toBeDefined()
  })

  it("bounds provider attachments before resolving lazy data", async () => {
    const threadId = "thread-attachment-limit"
    runtime(threadId, [])
    const fetchData = vi.fn(async () => new Uint8Array())
    const adapter = createProviderAgentAdapter({ execution: { attachments: { maxBytes: 10 } }, provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, {
      messages: [{ parts: [{ text: "inspect", type: "text" }, { fetchData, mediaType: "image/png", size: 11, type: "image" }], role: "user" }],
    }) as never)).rejects.toThrow("exceeds maxBytes")

    expect(fetchData).not.toHaveBeenCalled()
  })

  it("materializes application-resolved image attachments for the provider", async () => {
    const threadId = "thread-attachment-url"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const fetchData = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId, {
      messages: [{ parts: [{ text: "inspect", type: "text" }, { fetchData, mediaType: "image/png", type: "image", url: "https://assets.example/image.png" }], role: "user" }],
    }) as never)

    expect(fetchData).toHaveBeenCalledOnce()
    expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ mimeType: "image/png", sizeBytes: 3, type: "image" })],
    }))
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await rm(provider.attachmentsDirectory as string, { force: true, recursive: true })
  })

  it("requires application-owned resolution for provider attachment URLs", async () => {
    const threadId = "thread-attachment-url"
    runtime(threadId, [])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, {
      messages: [{ parts: [{ text: "inspect", type: "text" }, { mediaType: "image/png", type: "image", url: "https://assets.example/image.png" }], role: "user" }],
    }) as never)).rejects.toThrow("application-owned fetchData() resolution")
  })

  it("accepts an image-only provider turn", async () => {
    const threadId = "thread-attachment-only"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId, {
      input: {},
      messages: [{ parts: [{ data: new Uint8Array([1]), mediaType: "image/png", type: "image" }], role: "user" }],
      prompt: undefined,
    }) as never)

    expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: "Inspect the attached image." }))
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await rm(provider.attachmentsDirectory as string, { force: true, recursive: true })
  })

  it("does not replay historical approval and input responses on a resumed turn", async () => {
    const threadId = "thread-input-history"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: "resume-input" })
    const resumed = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "claude-code" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId) as never)
    const messages = [{
      parts: [
        { approved: true, id: "approval-1", type: "approval-decision" },
        { data: { answers: { scope: "workspace" }, requestId: "input-1" }, type: "data-agent-input" },
      ],
      role: "assistant",
    }, {
      parts: [{ text: "continue", type: "text" }],
      role: "user",
    }]

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId, { input: { prompt: "continue" }, messages, prompt: "continue" }) as never)

    expect(resumed.respondToRequest).not.toHaveBeenCalled()
    expect(resumed.respondToUserInput).not.toHaveBeenCalled()
    expect(resumed.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: "continue", threadId }))
  })

  it("routes live approval and provider input responses without claiming steering", async () => {
    const threadId = "thread-live-input"
    let release!: () => void
    const response = new Promise<void>((resolve) => {
      release = resolve
    })
    let requestsReady!: () => void
    const ready = new Promise<void>((resolve) => {
      requestsReady = resolve
    })
    const provider = runtime(threadId, [
      event("request.opened", threadId, { args: { command: "git status" }, requestType: "command" }, { requestId: "approval-1", turnId: "turn-1" }),
      event("user-input.requested", threadId, { questions: [{ id: "scope" }] }, { requestId: "input-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ], {
      async beforeEvent(index) {
        if (index !== 2) return
        requestsReady()
        await response
      },
    })
    provider.respondToUserInput.mockImplementation(async () => {
      release()
      return undefined
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const invocationId = `run-${threadId}`
    const liveContext = context(threadId)
    liveContext.runtime = withAgentInvocationResponseOwner(liveContext.runtime, invocationId)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = collect(await adapter.stream!(liveContext as never))

    await vi.waitFor(() => expect(agentInvocationInputSupport(invocationId)).toEqual({ respond: true }))
    await ready
    await expect(sendAgentInvocationInput(invocationId, { prompt: "change course" }, { mode: "steer" })).resolves.toBe("unsupported")
    await expect(sendAgentInvocationInput(invocationId, {
      messages: [{
        id: "response-1",
        parts: [
          { approved: true, id: "approval-1", type: "approval-decision" },
          { data: { answers: { scope: "workspace" }, requestId: "input-1" }, type: "data-agent-input" },
        ],
        role: "user",
      }],
    }, { mode: "respond" })).resolves.toBe("accepted")
    await expect(result).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: { questions: [{ id: "scope" }], requestId: "input-1", status: "requested" }, type: "data-agent-input" }),
    ]))
    expect(provider.respondToRequest).toHaveBeenCalledWith(threadId, "approval-1", "accept")
    expect(provider.respondToUserInput).toHaveBeenCalledWith(threadId, "input-1", { scope: "workspace" })
  })

  it("preserves the primary input handler during auxiliary provider runs", async () => {
    const primaryThreadId = "thread-primary-input"
    const controller = new AbortController()
    const primary = runtime(primaryThreadId, [], { afterEvents: () => new Promise(() => {}) })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const invocationId = `run-${primaryThreadId}`
    const primaryContext = context(primaryThreadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
    })
    primaryContext.runtime = withAgentInvocationResponseOwner(primaryContext.runtime, invocationId)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const primaryResult = adapter.generate(primaryContext as never)

    await vi.waitFor(() => expect(agentInvocationInputSupport(invocationId)).toEqual({ respond: true }))
    const auxiliaryThreadId = "thread-auxiliary-input"
    runtime(auxiliaryThreadId, [event("turn.completed", auxiliaryThreadId, { state: "completed" }, { turnId: "turn-1" })])
    const auxiliaryContext = context(auxiliaryThreadId)
    auxiliaryContext.runtime.run.runId = invocationId
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(markAuxiliaryMessageChannelInstructionContext(auxiliaryContext) as never)

    expect(agentInvocationInputSupport(invocationId)).toEqual({ respond: true })
    controller.abort("cancelled")
    await expect(primaryResult).rejects.toBe("cancelled")
    expect(primary.interruptTurn).toHaveBeenCalledWith(primaryThreadId, "turn-1")
  })

  it("declines approval requests from auxiliary provider runs", async () => {
    const threadId = "thread-auxiliary-approval"
    const provider = runtime(threadId, [
      event("request.opened", threadId, { args: { command: "git status" }, requestType: "command" }, { requestId: "approval-1", turnId: "turn-1" }),
      event("request.resolved", threadId, { decision: "decline" }, { requestId: "approval-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const auxiliaryContext = markAuxiliaryMessageChannelInstructionContext(context(threadId))

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate(auxiliaryContext as never)

    expect(provider.respondToRequest).toHaveBeenCalledWith(threadId, "approval-1", "decline")
  })

  it("declines approval requests from uncontrolled direct provider runs", async () => {
    const threadId = "thread-direct-approval"
    const provider = runtime(threadId, [
      event("request.opened", threadId, { args: { command: "git status" }, requestType: "command" }, { requestId: "approval-1", turnId: "turn-1" }),
      event("request.resolved", threadId, { decision: "decline" }, { requestId: "approval-1", turnId: "turn-1" }),
      event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" }),
    ])
    const directContext = context(threadId)

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate(directContext as never)

    expect(provider.respondToRequest).toHaveBeenCalledWith(threadId, "approval-1", "decline")
  })

  it("serves Capability tools through the provider MCP boundary", async () => {
    const execute = vi.fn(async (input: unknown) => ({ echoed: input }))
    runtime("thread-tools", [event("turn.completed", "thread-tools", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        expect(mcp).toBeDefined()
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["search"])
        await expect(client.callTool({ arguments: { query: "vitehub" }, name: "search" })).resolves.toMatchObject({
          content: [{ text: '{"echoed":{"query":"vitehub"}}', type: "text" }],
        })
        await client.close()
      },
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context("thread-tools", {
      tools: {
        search: {
          execute,
          inputSchema: { additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"], type: "object" },
          name: "search",
        },
      },
    }) as never)).resolves.toMatchObject({ text: "" })
    expect(execute).toHaveBeenCalledWith({ query: "vitehub" }, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }))
  })

  it("publishes Capability approval requests raised through MCP", async () => {
    let toolCall!: Promise<unknown>
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const policy = vi.fn(() => "require-approval" as const)
    runtime("thread-tool-approval", [event("turn.completed", "thread-tool-approval", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        toolCall = client.callTool({ arguments: { recipient: "team@example.com" }, name: "email_send" }).finally(() => client.close())
        await vi.waitFor(() => expect(policy).toHaveBeenCalledOnce())
        await Promise.resolve()
      },
    })
    const reportToolStep = vi.fn(async () => undefined)
    const tools = withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies({
      email_send: {
        execute: vi.fn(async () => undefined),
        name: "email_send",
        policy,
      },
    })!), reportToolStep)

    const invocationId = "run-thread-tool-approval"
    const approvalContext = context("thread-tool-approval", { tools })
    approvalContext.runtime = withAgentInvocationResponseOwner(approvalContext.runtime, invocationId)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const output = createProviderAgentAdapter({ provider: "codex" }).stream!(approvalContext as never) as AsyncIterable<unknown>
    const stream = output[Symbol.asyncIterator]()
    const approval = await stream.next()
    expect(approval.value).toEqual(expect.objectContaining({
      input: { recipient: "team@example.com" },
      name: "email_send",
      type: "approval-request",
    }))
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const approvalId = (approval.value as { id: string }).id
    await expect(Promise.all([
      sendAgentInvocationInput(invocationId, {
        messages: [{ id: "approval", parts: [{ approved: true, id: approvalId, type: "approval-decision" }], role: "user" }],
      }, { mode: "respond" }),
      sendAgentInvocationInput(invocationId, {
        messages: [{ id: "duplicate", parts: [{ approved: false, id: approvalId, type: "approval-decision" }], role: "user" }],
      }, { mode: "respond" }),
    ])).resolves.toEqual(["accepted", "unsupported"])
    await expect(toolCall).resolves.toMatchObject({ content: [{ text: "null", type: "text" }] })
    expect(reportToolStep).toHaveBeenCalledWith(expect.objectContaining({ toolResults: [expect.objectContaining({ output: null })] }))
    await expect(stream.next()).resolves.toMatchObject({ value: { type: "finish" } })
  })

  it("does not execute approved Capability calls after the MCP request is canceled", async () => {
    let toolCall!: Promise<unknown>
    const controller = new AbortController()
    const execute = vi.fn(async () => undefined)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const policy = vi.fn(() => "require-approval" as const)
    const provider = runtime("thread-tool-cancel", [event("turn.completed", "thread-tool-cancel", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        toolCall = client.callTool({ arguments: { recipient: "team@example.com" }, name: "email_send" }, undefined, { signal: controller.signal }).finally(() => client.close())
        await vi.waitFor(() => expect(policy).toHaveBeenCalledOnce())
        controller.abort()
        await expect(toolCall).rejects.toThrow(/AbortError/)
        await new Promise(resolve => setTimeout(resolve, 20))
      },
    })
    const tools = applyAgentToolPolicies({ email_send: { execute, name: "email_send", policy } })!
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const output = createProviderAgentAdapter({ provider: "codex" }).stream!(context("thread-tool-cancel", { tools }) as never) as AsyncIterable<unknown>
    const stream = output[Symbol.asyncIterator]()
    const approval = await stream.next()

    await expect(stream.next()).resolves.toMatchObject({ value: { type: "finish" } })
    await expect(sendAgentInvocationInput("run-thread-tool-cancel", {
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      messages: [{ id: "approval", parts: [{ approved: true, id: (approval.value as { id: string }).id, type: "approval-decision" }], role: "user" }],
    }, { mode: "respond" })).resolves.not.toBe("accepted")
    expect(execute).not.toHaveBeenCalled()
    expect(provider.respondToRequest).not.toHaveBeenCalled()
  })

  it("does not execute Capability calls canceled during asynchronous validation", async () => {
    let finishValidation!: () => void
    let validationStarted!: () => void
    const validationReady = new Promise<void>(resolve => validationStarted = resolve)
    const validationRelease = new Promise<void>(resolve => finishValidation = resolve)
    const controller = new AbortController()
    const execute = vi.fn(async () => undefined)
    runtime("thread-tool-validation-cancel", [event("turn.completed", "thread-tool-validation-cancel", { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn(mcp) {
        const client = new McpClient({ name: "provider-test", version: "1" })
        const transport = new StreamableHTTPClientTransport(new URL(mcp!.endpoint), {
          requestInit: { headers: { Authorization: mcp!.authorizationHeader } },
        })
        await client.connect(transport)
        const toolCall = client.callTool({ arguments: {}, name: "delayed" }, undefined, { signal: controller.signal })
        const toolCallResult = toolCall.then(value => ({ value }), error => ({ error }))
        await validationReady
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 20))
        finishValidation()
        await expect(toolCallResult).resolves.toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/AbortError/) }) })
        await client.close()
      },
    })
    const tools = {
      delayed: {
        execute,
        inputSchema: {
          "~standard": {
            jsonSchema: { input: () => ({ additionalProperties: false, properties: {}, type: "object" }) },
            async validate(value: unknown) {
              validationStarted()
              await validationRelease
              return { value }
            },
            vendor: "vitehub-test",
            // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
            version: 1 as const,
          },
        },
        name: "delayed",
      },
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(context("thread-tool-validation-cancel", { tools }) as never)).resolves.toBeDefined()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ["clean", { exitKind: "clean" }],
    ["recoverable error", { exitKind: "error", reason: "provider restarted", recoverable: true }],
  ])("fails when the active provider session exits with a %s result", async (_name, payload) => {
    const threadId = "thread-session-exited"
    runtime(threadId, [event("session.exited", threadId, payload)])

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId) as never))
      .rejects.toThrow(/session exited before the turn completed/)
  })

  it("force-closes an aborted Workspace process tree before settling execution", async () => {
    const threadId = "thread-workspace-child-close"
    let host: { exec: (command: string, args: string[], options: { signal: AbortSignal }) => Promise<unknown> } | undefined
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      async onSendTurn() {
        const controller = new AbortController()
        const startedAt = performance.now()
        const execution = host!.exec(process.execPath, ["-e", "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { signal: controller.signal })
        setTimeout(() => controller.abort(), 50)
        await expect(execution).rejects.toMatchObject({ name: "AbortError" })
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250)
        expect(performance.now() - startedAt).toBeLessThan(2_000)
      },
    })
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { host: typeof host }) => {
        host = options.host
        return session
      }),
      tools: {},
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)

    expect(session.close).toHaveBeenCalledOnce()
  })

  it("reaps Workspace process groups after successful commands", async () => {
    const heartbeatFile = `/tmp/vitehub-provider-success-descendant-${crypto.randomUUID()}`
    const descendant = `const fs=require('node:fs');const file=${JSON.stringify(heartbeatFile)};process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(file,String(Date.now())),20)`
    const command = `const{spawn}=require('node:child_process');const{existsSync}=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']}).unref();const wait=()=>existsSync(${JSON.stringify(heartbeatFile)})?process.exit(0):setTimeout(wait,5);wait()`

    await expect(localWorkspaceHost().exec(process.execPath, ["-e", command])).resolves.toMatchObject({ code: 0 })
    const stoppedAt = await readFile(heartbeatFile, "utf8")
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(readFile(heartbeatFile, "utf8")).resolves.toBe(stoppedAt)
    await rm(heartbeatFile, { force: true })
  })

  it("reports executable modes while listing local Workspace files", async () => {
    const root = `/tmp/vitehub-provider-file-modes-${crypto.randomUUID()}`
    await mkdir(root, { recursive: true })
    try {
      await writeFile(`${root}/README.md`, "docs")
      await writeFile(`${root}/group.sh`, "#!/bin/sh\n")
      await writeFile(`${root}/run.sh`, "#!/bin/sh\n")
      await chmod(`${root}/group.sh`, 0o010)
      await chmod(`${root}/run.sh`, 0o755)

      await expect(localWorkspaceHost().files.list(root)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ executable: false, path: `${root}/group.sh`, type: "file" }),
        expect.objectContaining({ executable: false, path: `${root}/README.md`, type: "file" }),
        expect.objectContaining({ executable: true, path: `${root}/run.sh`, type: "file" }),
      ]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("stops local Workspace traversal when cleanup is aborted", async () => {
    const root = `/tmp/vitehub-provider-aborted-traversal-${crypto.randomUUID()}`
    await mkdir(root, { recursive: true })
    try {
      await writeFile(`${root}/README.md`, "docs")
      const controller = new AbortController()
      const reason = new DOMException("cleanup deadline", "TimeoutError")
      controller.abort(reason)

      await expect(localWorkspaceHost().files.list(root, { recursive: true, signal: controller.signal })).rejects.toBe(reason)
      await expect(localWorkspaceHost().files.read(`${root}/README.md`, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("binds Workspace command directory variables to the active root", async () => {
    const cwd = new URL("fixtures/workspace-source-root", import.meta.url).pathname
    const result = await localWorkspaceHost().exec(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ INIT_CWD: process.env.INIT_CWD, OLDPWD: process.env.OLDPWD, PWD: process.env.PWD, cwd: process.cwd() }))"], {
      cwd,
      env: { INIT_CWD: "/host/init", OLDPWD: "/host/old", PWD: "/host/current" },
    })

    expect(JSON.parse(result.stdout)).toEqual({ INIT_CWD: cwd, OLDPWD: cwd, PWD: cwd, cwd })
  })

  it("filters ambient secrets from Workspace command environments", async () => {
    const previousSecret = process.env.VITEHUB_PROVIDER_HOST_SECRET
    process.env.VITEHUB_PROVIDER_HOST_SECRET = "host-secret"
    try {
      const result = await localWorkspaceHost().exec(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ explicit: process.env.EXPLICIT_VALUE, secret: process.env.VITEHUB_PROVIDER_HOST_SECRET }))"], {
        env: { EXPLICIT_VALUE: "selected" },
      })

      expect(JSON.parse(result.stdout)).toEqual({ explicit: "selected" })
    }
    finally {
      if (previousSecret === undefined) delete process.env.VITEHUB_PROVIDER_HOST_SECRET
      else process.env.VITEHUB_PROVIDER_HOST_SECRET = previousSecret
    }
  })

  it("keeps a one-shot host alive until process-group escalation settles", async () => {
    const heartbeatFile = `/tmp/vitehub-provider-descendant-${crypto.randomUUID()}`
    const script = `
      import { existsSync, readFileSync } from 'node:fs'
      import { setTimeout as delay } from 'node:timers/promises'
      import { localWorkspaceHost } from './src/provider-agent.ts'
      const controller = new AbortController()
      localWorkspaceHost().exec(process.execPath, ['-e', "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\\"const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>writeFileSync(process.argv[1],String(Date.now())),20)\\",process.argv[1]],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)", process.env.HEARTBEAT_FILE], { signal: controller.signal })
        .then(() => { throw new Error('expected abort') }, async () => {
          const stoppedAt = readFileSync(process.env.HEARTBEAT_FILE, 'utf8')
          await delay(100)
          if (readFileSync(process.env.HEARTBEAT_FILE, 'utf8') !== stoppedAt) throw new Error('descendant survived')
          console.log('settled')
        })
      const ready = setInterval(() => {
        if (!existsSync(process.env.HEARTBEAT_FILE)) return
        clearInterval(ready)
        controller.abort()
      }, 5)
    `
    const result = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, HEARTBEAT_FILE: heartbeatFile },
      timeout: 3_000,
    })

    await rm(heartbeatFile, { force: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe("settled")
  })

  it("bounds asynchronous instruction resolution by the invocation timeout", async () => {
    const adapter = createProviderAgentAdapter({
      instructions: async () => await new Promise<string>(() => undefined),
      provider: "codex",
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context("thread-instruction-timeout", {
      input: { prompt: "hello", timeout: 20 },
    }) as never)).rejects.toThrow()
  })

  it("reports native Claude Workspace instructions to invocation inspection", async () => {
    const threadId = "thread-native-claude-instructions"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    let root = ""
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        await mkdir(root, { recursive: true })
        await writeFile(`${root}/CLAUDE.md`, "native workspace instructions")
        return session
      }),
      tools: {},
    }
    const runContext = context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    })
    setAgentTelemetryConfiguration(runContext.context, {
      driver: { kind: "provider", provider: "claude-code" },
      runtime: { name: "vite" },
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "claude-code" }).generate(runContext as never)

    expect(getAgentTelemetryConfiguration(runContext.context)?.value.instructions).toEqual(["native workspace instructions"])
  })

  it("materializes AGENTS.md fallback instructions for Claude", async () => {
    const threadId = "thread-claude-agents-fallback"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    let root = ""
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async (command: string, args: string[]) => {
        if (command === "git" && args.includes("add")) {
          expect(await readFile(`${root}/CLAUDE.md`, "utf8")).toBe("workspace instructions")
        }
        return { code: 0, stderr: "", stdout: "" }
      }),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        await mkdir(root, { recursive: true })
        await writeFile(`${root}/AGENTS.md`, "workspace instructions")
        return session
      }),
      tools: {},
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "claude-code" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)

    expect(session.exec).toHaveBeenCalled()
  })

  it("reports runtime-wide provider errors without a thread association", async () => {
    runtime("thread-global-error", [{ payload: { message: "runtime failed" }, type: "runtime.error" }])

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(context("thread-global-error") as never))
      .rejects.toThrow("runtime failed")
  })

  it("restores a symlinked provider instruction entry without overwriting its target", async () => {
    const threadId = "thread-symlinked-instructions"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    let root = ""
    const session = {
      close: vi.fn(async () => {
        expect((await lstat(`${root}/CLAUDE.md`)).isSymbolicLink()).toBe(true)
        expect(await readlink(`${root}/CLAUDE.md`)).toBe("AGENTS.md")
        expect(await readFile(`${root}/AGENTS.md`, "utf8")).toBe("workspace instructions")
      }),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        await mkdir(root, { recursive: true })
        await writeFile(`${root}/AGENTS.md`, "workspace instructions")
        await symlink("AGENTS.md", `${root}/CLAUDE.md`)
        return session
      }),
      tools: {},
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ instructions: "generated instructions", provider: "claude-code" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)
  })

  it("restores the executable mode of a generated instruction entry", async () => {
    const threadId = "thread-executable-instructions"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    let root = ""
    const session = {
      close: vi.fn(async () => {
        expect((await lstat(`${root}/AGENTS.md`)).mode & 0o777).toBe(0o755)
      }),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        await writeFile(`${root}/AGENTS.md`, "workspace instructions")
        await chmod(`${root}/AGENTS.md`, 0o755)
        return session
      }),
      tools: {},
    }

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ instructions: "generated instructions", provider: "codex" }).generate(context(threadId, {
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)
  })

  it("writes successful workspace sessions back before cleanup", async () => {
    const threadId = "thread-workspace"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = { fs: {}, startSession: vi.fn(async () => session), tools: {} }
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMaterializationPaths: ["skills/review"],
      workspaceMode: "write",
    }) as never)

    expect(workspace.startSession).toHaveBeenCalledWith(expect.objectContaining({ paths: undefined, target: expect.any(String) }))
    expect(workspace.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ writeBack: expect.anything() }))
    expect(session.commit).toHaveBeenCalledWith(expect.objectContaining({ message: "chore: save provider work" }))
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("keeps colocated Skills readable and out of Workspace writeback", async () => {
    const threadId = "thread-workspace-colocated-skills"
    let root = ""
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      async onStartSession() {
        await expect(readFile(`${root}/skills/review/SKILL.md`, "utf8")).resolves.toBe("# Review\n")
      },
    })
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => {
        await expect(access(`${root}/skills/review/SKILL.md`)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(access(`${root}/skills/review`)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(access(`${root}/skills`)).rejects.toMatchObject({ code: "ENOENT" })
        return { entries: [] }
      }),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        return session
      }),
      tools: {},
    }
    const runContext = context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    })
    runContext.context.set("agent.colocatedSkills", {
      review: { content: "# Review\n", workspacePath: "skills/review/SKILL.md" },
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await createProviderAgentAdapter({ provider: "codex" }).generate(runContext as never)

    expect(session.diff).toHaveBeenCalledOnce()
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("rejects colocated Skill materialization through Workspace symlinks", async () => {
    const threadId = "thread-workspace-symlinked-skills"
    const runtimeCount = createProviderRuntime.mock.calls.length
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        await symlink("/tmp", `${options.target}/skills`)
        return session
      }),
      tools: {},
    }
    const runContext = context(threadId, { workspace })
    runContext.context.set("agent.colocatedSkills", {
      review: { content: "# Review\n", workspacePath: "skills/review/SKILL.md" },
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(createProviderAgentAdapter({ provider: "codex" }).generate(runContext as never)).rejects.toThrow("parent must not be a symbolic link")

    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCount)
    expect(session.diff).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("clears a provider cursor when Workspace write-back fails", async () => {
    const threadId = "thread-workspace-failed-resume"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "successful-cursor",
    })
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
      turnResumeCursor: "uncommitted-cursor",
    })
    const recovered = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const sessions = [
      {
        close: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        diff: vi.fn(async () => ({ entries: [] })),
        exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
        readFile: vi.fn(async () => new Uint8Array()),
      },
      {
        close: vi.fn(async () => undefined),
        commit: vi.fn(async () => { throw new Error("write-back failed") }),
        diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
        exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
        readFile: vi.fn(async () => new Uint8Array()),
      },
    ]
    const workspace = { fs: {}, startSession: vi.fn(async () => sessions.shift()), tools: {} }
    const runContext = () => context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMode: "write",
    })
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(runContext() as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(runContext() as never)).rejects.toThrow("Provider Agent Driver cleanup failed")
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(context(threadId) as never)

    expect(recovered.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
  })

  it("writes successful streaming Workspace sessions back when UI projection stops at finish", async () => {
    const threadId = "thread-workspace-stream"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const stream = await adapter.stream!(context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMode: "write",
    }) as never)

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    for await (const item of stream as AsyncIterable<{ type?: string }>) {
      if (item.type === "finish") break
    }

    expect(session.commit).toHaveBeenCalledWith(expect.objectContaining({ message: "chore: save provider work" }))
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not write back a read-only Workspace", async () => {
    const threadId = "thread-workspace-read"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const workspace = { fs: {}, startSession: vi.fn(async () => session), tools: {} }
    const runContext = context(threadId, {
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
      workspaceMode: "read",
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(runContext as never)

    expect(session.diff).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(workspace.startSession).toHaveBeenCalledWith(expect.objectContaining({ writeBack: false }))
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    expect(readAgentWorkspaceDiff(runContext.context as never)).toBeUndefined()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("does not publish a Workspace diff without a successful commit", async () => {
    const threadId = "thread-workspace-uncommitted"
    runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const runContext = context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await adapter.generate(runContext as never)

    expect(session.diff).toHaveBeenCalledOnce()
    expect(session.commit).not.toHaveBeenCalled()
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    expect(readAgentWorkspaceDiff(runContext.context as never)).toBeUndefined()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("treats every non-completed terminal state as a failed Workspace run", async () => {
    const threadId = "thread-failed"
    runtime(threadId, [event("turn.completed", threadId, { state: "interrupted" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
    }) as never)).rejects.toThrow("Provider turn interrupted")

    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })

  it("interrupts aborted turns and skips write-back", async () => {
    const threadId = "thread-abort"
    const provider = runtime(threadId, [event("turn.aborted", threadId, { reason: "cancelled" }, { turnId: "turn-1" })])
    const controller = new AbortController()
    controller.abort("cancelled")
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [{ path: "result.md", type: "modified" }] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async () => session),
      tools: {},
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    const runtimeCalls = createProviderRuntime.mock.calls.length

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
      workspace,
      workspaceAutoCommit: true,
      workspaceDefinition: { commit: "chore: save provider work", name: "docs" },
    }) as never)).rejects.toBe("cancelled")

    expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls)
    expect(provider.startSession).not.toHaveBeenCalled()
    expect(provider.sendTurn).not.toHaveBeenCalled()
    expect(provider.interruptTurn).not.toHaveBeenCalled()
    expect(workspace.startSession).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.close).not.toHaveBeenCalled()
    expect(provider.close).not.toHaveBeenCalled()
    providerRuntimes.pop()
  })

  it("reports a spontaneous provider abort as a failed UI stream", async () => {
    const threadId = "thread-provider-abort"
    runtime(threadId, [event("turn.aborted", threadId, { reason: "provider stopped" }, { turnId: "turn-1" })])
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const events = await adapter.stream!(context(threadId) as never)
    const output = await finalizeUiMessageStreamOutput(events, true, () => undefined)

    await expect(collect(output.value)).rejects.toThrow("Provider turn aborted: provider stopped")
  })

  it("cancels when the provider emits no terminal event", async () => {
    const threadId = "thread-cancel-race"
    const provider = runtime(threadId, [], { afterEvents: () => new Promise(() => {}) })
    const controller = new AbortController()
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = adapter.generate(context(threadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
    }) as never)

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce())
    controller.abort("cancelled")

    await expect(result).rejects.toBe("cancelled")
    expect(provider.interruptTurn).toHaveBeenCalledWith(threadId, "turn-1")
    expect(provider.close).toHaveBeenCalledOnce()
  })

  it("retains an already-aborted late provider close before deleting its root", async () => {
    const threadId = "thread-cancel-late-close"
    const provider = runtime(threadId, [], { afterEvents: () => new Promise(() => {}) })
    let resolveClose!: () => void
    provider.close.mockImplementationOnce(() => new Promise<undefined>(resolve => resolveClose = () => resolve(undefined)))
    const controller = new AbortController()
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      input: { abortSignal: controller.signal, prompt: "hello" },
    }) as never)

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce())
    const runtimeCall = createProviderRuntime.mock.lastCall
    expect(runtimeCall).toBeDefined()
    // SAFETY: This test fixture intentionally reads the Provider runtime working directory.
    const root = (runtimeCall![0] as { cwd: string }).cwd
    controller.abort("cancelled")

    await expect(result).rejects.toBe("cancelled")
    await expect(access(root)).resolves.toBeUndefined()
    resolveClose()
    await vi.waitFor(async () => await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
  })

  it("removes Codex credentials when aborted provider cleanup never settles", async () => {
    vi.useFakeTimers()
    try {
      const threadId = "thread-cancel-provider-cleanup"
      const provider = runtime(threadId, [], { afterEvents: () => new Promise(() => {}) })
      provider.close.mockImplementationOnce(() => new Promise(() => {}))
      const controller = new AbortController()
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
      })
      const runContext = context(threadId, {
        input: { abortSignal: controller.signal, prompt: "hello" },
      })
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      const result = adapter.generate(runContext as never)

      await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce())
      expect(createProviderRuntime.mock.lastCall?.[0].settings?.homePath).toEqual(expect.any(String))
      const shadowHome = String(createProviderRuntime.mock.lastCall?.[0].settings?.homePath)
      const runtimeCall = createProviderRuntime.mock.lastCall
      expect(runtimeCall).toBeDefined()
      // SAFETY: This test fixture intentionally reads the Provider runtime working directory.
      const root = (runtimeCall![0] as { cwd: string }).cwd
      await expect(access(shadowHome)).resolves.toBeUndefined()
      await expect(access(root)).resolves.toBeUndefined()
      controller.abort("cancelled")
      await expect(result).rejects.toBe("cancelled")
      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(async () => await expect(access(shadowHome)).rejects.toMatchObject({ code: "ENOENT" }))
      await vi.waitFor(async () => await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("removes Codex credentials when aborted provider startup never settles", async () => {
    vi.useFakeTimers()
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    try {
      const threadId = "thread-cancel-provider-startup"
      const runtimeCalls = createProviderRuntime.mock.calls.length
      createProviderRuntime.mockImplementationOnce(() => new Promise(() => {}))
      const controller = new AbortController()
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
        providerSettings: { homePath: sharedHome },
      })
      const runContext = context(threadId, {
        input: { abortSignal: controller.signal, prompt: "hello" },
      })
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      const result = adapter.generate(runContext as never)

      await vi.waitFor(() => expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 1))
      expect(createProviderRuntime.mock.lastCall?.[0].settings?.homePath).toEqual(expect.any(String))
      const shadowHome = String(createProviderRuntime.mock.lastCall?.[0].settings?.homePath)
      await expect(access(shadowHome)).resolves.toBeUndefined()
      controller.abort("cancelled")
      await expect(result).rejects.toBe("cancelled")
      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(async () => await expect(access(shadowHome)).rejects.toMatchObject({ code: "ENOENT" }))
      const nextThreadId = "thread-after-cancelled-provider-startup"
      const nextProvider = runtime(nextThreadId, [event("turn.completed", nextThreadId, { state: "completed" }, { turnId: "turn-1" })])
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      await expect(adapter.generate(context(nextThreadId) as never)).resolves.toBeDefined()
      expect(nextProvider.startSession).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
      await rm(sharedHome, { force: true, recursive: true })
    }
  })

  it("times out a provider turn and releases its resources", async () => {
    const threadId = "thread-timeout"
    const provider = runtime(threadId, [], { afterEvents: () => new Promise(() => {}) })
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 250 },
    }) as never)

    await vi.waitFor(() => expect(provider.sendTurn).toHaveBeenCalledOnce())
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    expect(provider.interruptTurn).toHaveBeenCalledWith(threadId, "turn-1")
    expect(provider.close).toHaveBeenCalledOnce()
  })

  it("retains the shared-home lock after forced credential removal until runtime shutdown", async () => {
    vi.useFakeTimers()
    const sharedHome = await mkdtemp(join(tmpdir(), "vitehub-codex-shared-home-"))
    let finishClose: (() => void) | undefined
    try {
      const threadId = "thread-cleanup-timeout-first"
      const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
      provider.close.mockImplementationOnce(() => new Promise<undefined>(resolve => finishClose = () => resolve(undefined)))
      const adapter = createProviderAgentAdapter({
        credentials: '{"tokens":{"access_token":"secret"}}',
        provider: "codex",
        providerSettings: { homePath: sharedHome },
      })
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      const stream = await adapter.stream!(context(threadId) as never)
      const result = collect(stream)

      await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
      const runtimeCall = createProviderRuntime.mock.lastCall
      expect(runtimeCall).toBeDefined()
      expect(runtimeCall?.[0].settings?.homePath).toEqual(expect.any(String))
      const shadowHome = String(runtimeCall?.[0].settings?.homePath)
      await expect(access(shadowHome)).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(result).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ recoverable: true, type: "error" }),
      ]))
      await vi.waitFor(async () => await expect(access(shadowHome)).rejects.toMatchObject({ code: "ENOENT" }))
      const nextThreadId = "thread-cleanup-timeout-second"
      const nextProvider = runtime(nextThreadId, [event("turn.completed", nextThreadId, { state: "completed" }, { turnId: "turn-1" })])
      // SAFETY: This test fixture intentionally constructs the exact provider run context.
      const nextResult = adapter.generate(context(nextThreadId) as never)
      await vi.advanceTimersByTimeAsync(25)
      expect(nextProvider.startSession).not.toHaveBeenCalled()

      finishClose?.()
      await vi.advanceTimersByTimeAsync(0)
      await expect(nextResult).resolves.toBeDefined()
      expect(nextProvider.startSession).toHaveBeenCalledOnce()
    }
    finally {
      finishClose?.()
      vi.useRealTimers()
      await rm(sharedHome, { force: true, recursive: true })
    }
  })

  it("aborts Workspace close before removing the provider root", async () => {
    vi.useFakeTimers()
    try {
      const threadId = "thread-workspace-cleanup-timeout"
      runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
      let observedSignal: AbortSignal | undefined
      const session = {
        async close(options?: { abortSignal?: AbortSignal }) {
          observedSignal = options?.abortSignal
          if (!observedSignal) throw new Error("Expected bounded Workspace cleanup signal.")
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(observedSignal!.reason)
            observedSignal!.addEventListener("abort", abort, { once: true })
            if (observedSignal!.aborted) abort()
          })
        },
        commit: vi.fn(async () => undefined),
        diff: vi.fn(async () => ({ entries: [] })),
        exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
        readFile: vi.fn(async () => new Uint8Array()),
      }
      const adapter = createProviderAgentAdapter({ provider: "codex" })
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      const stream = await adapter.stream!(context(threadId, {
        workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      }) as never)
      const result = collect(stream)

      await vi.waitFor(() => expect(observedSignal).toBeDefined())
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(result).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ recoverable: true, type: "error" }),
      ]))
      expect(observedSignal?.aborted).toBe(true)
      const runtimeCall = createProviderRuntime.mock.lastCall
      expect(runtimeCall).toBeDefined()
      // SAFETY: This test fixture intentionally reads the Provider runtime working directory.
      const root = (runtimeCall![0] as { cwd: string }).cwd
      await vi.waitFor(async () => await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("removes provider roots in a child process", async () => {
    if (process.platform === "win32") return
    const fixture = await mkdtemp("/tmp/vitehub-provider-rm-test-")
    const marker = `${fixture}/started`
    const executable = `${fixture}/rm`
    const previousPath = process.env.PATH
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexec /bin/rm "$@"\n`)
    await chmod(executable, 0o755)
    process.env.PATH = `${fixture}:${previousPath || ""}`
    try {
      const threadId = "thread-external-root-cleanup"
      runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])

      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      await createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId) as never)

      const args = (await readFile(marker, "utf8")).trim().split("\n")
      expect(args.slice(0, 2)).toEqual(["-rf", "--"])
      expect(args[2]).toMatch(/^\/tmp\/vitehub-provider-/)
    }
    finally {
      process.env.PATH = previousPath
      await rm(fixture, { force: true, recursive: true })
    }
  })

  it("bounds retained provider cleanup before releasing its Workspace root", async () => {
    vi.useFakeTimers()
    try {
      const threadId = "thread-retained-cleanup-timeout"
      const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
      provider.close.mockImplementationOnce(() => new Promise(() => {}))
      const retained: Promise<unknown>[] = []
      const invocation = context(threadId, {
        input: { prompt: "hello", timeout: 50 },
        runtime: {
          memo: (_key: string, create: () => unknown) => create(),
          run: { runId: `run-${threadId}`, threadId },
          runtime: "vite",
          runtimeConfig: {},
          waitUntil: (task: PromiseLike<unknown>) => retained.push(Promise.resolve(task)),
        },
      })
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      const result = createProviderAgentAdapter({ provider: "codex" }).generate(invocation as never)

      await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(50)
      const runtimeCall = createProviderRuntime.mock.lastCall
      expect(runtimeCall).toBeDefined()
      if (!runtimeCall) throw new Error("Expected the Provider runtime to be created.")
      // SAFETY: This test fixture intentionally reads the Provider runtime working directory.
      const root = (runtimeCall[0] as { cwd: string }).cwd
      await expect(access(root)).resolves.toBeUndefined()

      await vi.advanceTimersByTimeAsync(9_950)
      await expect(result).resolves.toBeDefined()
      await expect(Promise.all(retained)).resolves.toBeDefined()
      await vi.waitFor(async () => await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds provider startup by the invocation timeout", async () => {
    const threadId = "thread-start-timeout"
    const provider = runtime(threadId, [], { onStartSession: () => new Promise(() => {}) })
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
    }) as never)).rejects.toMatchObject({ name: "TimeoutError" })

    expect(provider.startSession).toHaveBeenCalledOnce()
    expect(provider.sendTurn).not.toHaveBeenCalled()
    expect(provider.close).not.toHaveBeenCalled()
  })

  it("retains the Workspace root until late runtime creation is closed", async () => {
    const threadId = "thread-late-runtime"
    const lateRuntime = runtime(threadId, [])
    providerRuntimes.pop()
    let resolveRuntime!: (value: typeof lateRuntime) => void
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    createProviderRuntime.mockImplementationOnce(() => new Promise(resolve => resolveRuntime = resolve) as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      input: { prompt: "hello", timeout: 20 },
    }) as never)

    await vi.waitFor(() => expect(createProviderRuntime).toHaveBeenCalled())
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    const runtimeCall = createProviderRuntime.mock.lastCall
    expect(runtimeCall).toBeDefined()
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const root = (runtimeCall![0] as { cwd: string }).cwd
    await expect(access(root)).resolves.toBeUndefined()
    resolveRuntime(lateRuntime)
    await vi.waitFor(() => expect(lateRuntime.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
  })

  it("preserves cancellation when waitUntil rejects late cleanup registration", async () => {
    const threadId = "thread-late-runtime-wait-until"
    const lateRuntime = runtime(threadId, [])
    providerRuntimes.pop()
    let resolveRuntime!: (value: typeof lateRuntime) => void
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    createProviderRuntime.mockImplementationOnce(() => new Promise(resolve => resolveRuntime = resolve) as never)
    const invocation = context(threadId)
    const controller = new AbortController()
    const cancelled = new Error("cancelled")
    invocation.runtime.waitUntil = () => {
      throw new Error("registration failed")
    }
    const runtimeCalls = createProviderRuntime.mock.calls.length
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = createProviderAgentAdapter({ provider: "codex" }).generate({
      ...invocation,
      input: { abortSignal: controller.signal, prompt: "hello" },
    } as never)

    await vi.waitFor(() => expect(createProviderRuntime).toHaveBeenCalledTimes(runtimeCalls + 1))
    controller.abort(cancelled)
    await expect(result).rejects.toBe(cancelled)
    const runtimeCall = createProviderRuntime.mock.calls[runtimeCalls]
    expect(runtimeCall).toBeDefined()
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const root = (runtimeCall![0] as { cwd: string }).cwd
    resolveRuntime(lateRuntime)
    await vi.waitFor(() => expect(lateRuntime.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
  })

  it("removes the Workspace root when late runtime creation rejects", async () => {
    const threadId = "thread-late-runtime-rejection"
    let rejectRuntime!: (reason: unknown) => void
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    createProviderRuntime.mockImplementationOnce(() => new Promise((_resolve, reject) => rejectRuntime = reject) as never)
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = createProviderAgentAdapter({ provider: "codex" }).generate(context(threadId, {
      input: { prompt: "hello", timeout: 20 },
    }) as never)

    await vi.waitFor(() => expect(createProviderRuntime).toHaveBeenCalled())
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    const runtimeCall = createProviderRuntime.mock.lastCall
    expect(runtimeCall).toBeDefined()
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const root = (runtimeCall![0] as { cwd: string }).cwd
    await expect(access(root)).resolves.toBeUndefined()
    rejectRuntime(new Error("late startup failed"))
    await vi.waitFor(() => expect(access(root)).rejects.toMatchObject({ code: "ENOENT" }))
  })

  it("retains thread ownership until late Workspace preparation closes", async () => {
    const threadId = "thread-late-workspace"
    let finishPreparation!: (session: Record<string, unknown>) => void
    let finishClose!: () => void
    let lateRoot = ""
    const close = vi.fn(() => new Promise<void>(resolve => finishClose = resolve))
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        lateRoot = options.target
        await mkdir(lateRoot, { recursive: true })
        await writeFile(`${lateRoot}/late`, "owned")
        return await new Promise<Record<string, unknown>>(resolve => finishPreparation = resolve)
      }),
      tools: {},
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const first = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }) as never)

    await expect(first).rejects.toMatchObject({ name: "TimeoutError" })
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const second = adapter.generate(context(threadId) as never)
    finishPreparation({
      close,
      commit: async () => undefined,
      diff: async () => ({ entries: [] }),
      exec: async () => ({ code: 0, stderr: "", stdout: "" }),
      readFile: async () => new Uint8Array(),
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    await expect(access(`${lateRoot}/late`)).resolves.toBeUndefined()
    expect(provider.startSession).not.toHaveBeenCalled()
    finishClose()

    await expect(second).resolves.toBeDefined()
    await expect(access(lateRoot)).rejects.toMatchObject({ code: "ENOENT" })
    expect(provider.startSession).toHaveBeenCalledOnce()
  })

  it("stops provider startup that settles after timeout before closing its runtime", async () => {
    const threadId = "thread-late-start"
    let finishStartup!: () => void
    const provider = runtime(threadId, [], { onStartSession: () => new Promise<void>(resolve => finishStartup = resolve) })
    const waitUntil = vi.fn((promise: Promise<unknown>) => void promise.catch(() => undefined))
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      runtime: {
        memo: (_key: string, create: () => unknown) => create(),
        run: { runId: `run-${threadId}`, threadId },
        runtime: "vite",
        runtimeConfig: {},
        waitUntil,
      },
    }) as never)

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    expect(provider.close).not.toHaveBeenCalled()
    finishStartup()
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
    expect(provider.stopSession).toHaveBeenCalledWith(threadId)
    expect(waitUntil).toHaveBeenCalledOnce()
  })

  it("keeps the session lock until a stalled deferred runtime close settles", async () => {
    vi.useFakeTimers()
    try {
      const threadId = "thread-late-start-lock"
      let finishStartup!: () => void
      let finishClose!: () => void
      const first = runtime(threadId, [], { onStartSession: () => new Promise<void>(resolve => finishStartup = resolve) })
      first.close.mockImplementationOnce(() => new Promise<undefined>(resolve => finishClose = () => resolve(undefined)))
      const second = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
      const adapter = createProviderAgentAdapter({ provider: "codex" })
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      const firstResult = adapter.generate(context(threadId, { input: { prompt: "hello", timeout: 50 } }) as never)

      await vi.advanceTimersByTimeAsync(50)
      await expect(firstResult).rejects.toMatchObject({ name: "TimeoutError" })
      await vi.advanceTimersByTimeAsync(10_000)

      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      const secondResult = adapter.generate(context(threadId) as never)
      await vi.advanceTimersByTimeAsync(25)
      expect(second.startSession).not.toHaveBeenCalled()

      finishStartup()
      await vi.advanceTimersByTimeAsync(0)
      expect(first.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(second.startSession).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(second.startSession).not.toHaveBeenCalled()

      finishClose()
      await vi.advanceTimersByTimeAsync(0)
      await expect(secondResult).resolves.toBeDefined()
      expect(second.startSession).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("retains the session and provider root until deferred Workspace cleanup settles", async () => {
    const threadId = "thread-late-start-workspace"
    let finishStartup!: () => void
    let finishWorkspaceClose!: () => void
    const provider = runtime(threadId, [], { onStartSession: () => new Promise<void>(resolve => finishStartup = resolve) })
    const nextProvider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    const session = {
      close: vi.fn(() => new Promise<void>(resolve => finishWorkspaceClose = resolve)),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceDefinition: { mode: "write", name: "docs" },
    }) as never)

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    expect(session.close).not.toHaveBeenCalled()
    const runtimeCall = createProviderRuntime.mock.lastCall
    expect(runtimeCall).toBeDefined()
    // SAFETY: This test fixture intentionally reads the Provider runtime working directory.
    const root = (runtimeCall![0] as { cwd: string }).cwd
    finishStartup()
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce())
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const nextResult = adapter.generate(context(threadId) as never)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(nextProvider.startSession).not.toHaveBeenCalled()
    await expect(access(root)).resolves.toBeUndefined()

    finishWorkspaceClose()
    await expect(nextResult).resolves.toBeDefined()
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" })
    expect(nextProvider.startSession).toHaveBeenCalledOnce()
    expect(provider.stopSession).toHaveBeenCalledWith(threadId)
    expect(provider.close.mock.invocationCallOrder[0]).toBeLessThan(session.close.mock.invocationCallOrder[0]!)
  })

  it("closes a provider runtime when startup rejects after timeout", async () => {
    const threadId = "thread-late-start-rejection"
    let rejectStartup!: (error: Error) => void
    const provider = runtime(threadId, [], { onStartSession: () => new Promise<void>((_resolve, reject) => rejectStartup = reject) })
    const waitUntil = vi.fn((promise: Promise<unknown>) => void promise.catch(() => undefined))
    const adapter = createProviderAgentAdapter({ provider: "codex" })
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const result = adapter.generate(context(threadId, {
      input: { prompt: "hello", timeout: 50 },
      runtime: {
        memo: (_key: string, create: () => unknown) => create(),
        run: { runId: `run-${threadId}`, threadId },
        runtime: "vite",
        runtimeConfig: {},
        waitUntil,
      },
    }) as never)

    await expect(result).rejects.toMatchObject({ name: "TimeoutError" })
    rejectStartup(new Error("late startup failed"))
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce())
    expect(provider.stopSession).not.toHaveBeenCalled()
    expect(waitUntil).toHaveBeenCalledOnce()
  })

  it("closes the Workspace when provider shutdown fails", async () => {
    const threadId = "thread-close-failure"
    const provider = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })])
    provider.close.mockRejectedValueOnce(new Error("provider close failed"))
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const adapter = createProviderAgentAdapter({ provider: "codex" })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await expect(adapter.generate(context(threadId, {
      workspace: { fs: {}, startSession: vi.fn(async () => session), tools: {} },
      workspaceDefinition: { mode: "write", name: "docs" },
    }) as never)).rejects.toThrow("cleanup failed")

    expect(session.close).toHaveBeenCalledOnce()
  })
})
