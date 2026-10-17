import { execFile, spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

const relayServers = vi.hoisted(() => [] as import("node:net").Server[])
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>()
  const createServer = (...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args)
    relayServers.push(server)
    return server
  }
  return { ...actual, createServer }
})

const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: { environment?: Record<string, string>, settings?: Record<string, unknown> }) => providerRuntimes.shift()))
const createSqliteProviderRuntimeSessionStore = vi.hoisted(() => vi.fn(async (path: string) => ({
  close: vi.fn(),
  delete: vi.fn(async () => undefined),
  get: vi.fn(async () => undefined),
  path,
  set: vi.fn(async () => undefined),
})))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime, createSqliteProviderRuntimeSessionStore }))

const openedSandboxSession = vi.hoisted(() => ({ current: undefined as import("@vite-hub/sandbox").SandboxSession | undefined }))

/** Error that Sandbox session close reports after the real close. It simulates a failed cwd synchronization. */
const sandboxCloseFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }))
vi.mock("@vite-hub/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vite-hub/sandbox")>()
  const resolveSandbox: typeof actual.resolveSandbox = async (definition, context, options) => {
    const sandbox = await actual.resolveSandbox(definition, context, options)
    return {
      plan: sandbox.plan,
      async open(openOptions) {
        const session = await sandbox.open(openOptions)
        openedSandboxSession.current = session
        const error = sandboxCloseFailure.error
        if (!error) return session
        return {
          ...session,
          async close() {
            await session.close()
            throw error
          },
        }
      },
    }
  }
  return { ...actual, resolveSandbox }
})

import { defineAgent, type AgentSandboxDefinition, type AgentRuntimeConfig } from "../src/index.ts"
import { resolveAgentHealth } from "../src/health.ts"
import { sandboxSharesHostNetwork, providerSandboxEnvironment, startProviderSandboxRelay, type ProviderSandboxSession } from "../src/internal/provider-box.ts"
import { createProviderAgentAdapter } from "../src/provider-agent.ts"

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(relayServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  providerRuntimes.splice(0)
  createProviderRuntime.mockClear()
  vi.unstubAllEnvs()
  sandboxCloseFailure.error = undefined
  openedSandboxSession.current = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

interface PullRequestOptions {
  ref: string
  sha: string
  token: string
}

interface SandboxTestInput {
  options: PullRequestOptions
  prompt: string
}

interface LauncherResult {
  code: number | null
  stderr: string
  stdout: string
}

/** Script that the provider command runs inside the Sandbox. It reports what the provider can see. */
const probeScript = `
const { readFileSync } = require("node:fs")
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => input += chunk)
process.stdin.on("end", () => {
  const home = process.env.HOME
  process.stdout.write(JSON.stringify({
    agents: readFileSync(home + "/.codex/AGENTS.md", "utf8"),
    argv: process.argv.slice(1),
    config: readFileSync(home + "/.config/tool.json", "utf8"),
    cwd: process.cwd(),
    env: {
      SANDBOX_TOKEN: process.env.SANDBOX_TOKEN,
      DRIVER_VALUE: process.env.DRIVER_VALUE,
      HOST_ONLY: process.env.VITEHUB_SANDBOX_TEST_HOST_ONLY,
      RUNTIME_TOKEN: process.env.T3_MCP_BEARER_TOKEN,
    },
    home,
    input,
    readme: readFileSync("README.md", "utf8"),
  }))
  process.stderr.write("probe stderr\\n")
})
`

function event(type: string, threadId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { payload, threadId, type, ...extra }
}

function providerRuntime(threadId: string, onStartSession: (input: { cwd: string }) => Promise<void>) {
  const value = {
    attachmentsDirectory: `/tmp/attachments-${crypto.randomUUID()}`,
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        yield event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => ({ threadId, turnId: "turn-1" })),
    startSession: vi.fn(async (input: { cwd: string }) => {
      await onStartSession(input)
      return { threadId }
    }),
    stopSession: vi.fn(async () => undefined),
  }
  providerRuntimes.push(value)
  return value
}

function invocationContext(threadId: string, input: SandboxTestInput) {
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
    input,
    invoker: { id: "invoker", kind: "user" },
    messages: [],
    prompt: input.prompt,
    runtime: {
      memo: <T>(_key: string, create: () => T) => create(),
      run: { runId: `run-${threadId}`, threadId },
      runtime: "vite",
      runtimeConfig: {},
      waitUntil: () => undefined,
    },
  }
}

/** Start the launcher that the provider runtime receives as its provider binary. */
async function runLauncher(path: string, args: string[], options: { cwd: string, env: Record<string, string>, keepStdinOpen?: boolean, stdin: string }) {
  const child = spawn(path, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk)
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk)
  if (options.keepStdinOpen) child.stdin.write(options.stdin)
  else child.stdin.end(options.stdin)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  child.stdin.destroy()
  return { code, stderr, stdout } satisfies LauncherResult
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-sandbox-"))
  roots.push(root)
  return root
}

async function gitRepository(root: string) {
  const repository = join(root, "repository")
  await mkdir(repository)
  const git = (args: string[]) => execFileAsync("git", ["-C", repository, ...args])
  await git(["init", "--initial-branch=main"])
  await writeFile(join(repository, "README.md"), "first\n")
  await git(["add", "README.md"])
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "first"])
  const first = (await git(["rev-parse", "HEAD"])).stdout.trim()
  await git(["branch", "first"])
  await writeFile(join(repository, "README.md"), "second\n")
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-am", "second"])
  const second = (await git(["rev-parse", "HEAD"])).stdout.trim()
  return { first, repository, second }
}

type TestSandbox = AgentSandboxDefinition<AgentRuntimeConfig, PullRequestOptions>

function testSandbox(repository: string, requires: TestSandbox["requires"] = []): TestSandbox {
  return {
    checkout: {
      ref: ({ input }) => input.options?.ref,
      remote: async () => repository,
      sha: ({ input }) => input.options?.sha,
    },
    env: { SANDBOX_TOKEN: ({ input }) => input.options?.token },
    home: {
      files: {
        ".config/tool.json": { contents: ({ input }) => JSON.stringify({ sha: input.options?.sha }) },
      },
    },
    requires: ["git", ...requires],
    runtime: "trusted-host",
  }
}

describe("Agent Sandbox definitions", () => {
  it("accepts a built-in provider Driver and exposes the Sandbox definition", () => {
    const sandbox = { runtime: "trusted-host" } as const
    const agent = defineAgent({ sandbox, driver: { kind: "codex" } })
    expect(agent.sandbox).toBe(sandbox)
  })

  it.each([
    ["a Sandbox without runtime", { sandbox: {}, driver: { kind: "codex" } }, "AGENT_R0954"],
    ["a custom Driver", { sandbox: { runtime: "trusted-host" }, driver: { run: () => "ok" } }, "AGENT_R0955"],
    ["driver.launch", { sandbox: { runtime: "trusted-host" }, driver: { kind: "codex", launch: { command: "ssh" } } }, "AGENT_R0956"],
    ["driver.credentials", { sandbox: { runtime: "trusted-host" }, driver: { credentials: () => "{}", kind: "codex" } }, "AGENT_R0957"],
    ["an Agent Workspace", { sandbox: { runtime: "trusted-host" }, driver: { kind: "codex" }, workspace: {} }, "AGENT_R0958"],
  ])("rejects %s at definition time", (_name, options, code) => {
    // SAFETY: The invalid definitions exercise runtime validation for JavaScript callers.
    expect(() => defineAgent(options as never)).toThrow(expect.objectContaining({ code }))
  })

  it("keeps Agents without sandbox unchanged", () => {
    const agent = defineAgent({ driver: { kind: "codex" } })
    expect(agent.sandbox).toBeUndefined()
  })

  it("reports a configured Sandbox in health checks", async () => {
    const withSandbox = await resolveAgentHealth({ sandbox: { runtime: "trusted-host" }, name: "boxed" })
    const withoutSandbox = await resolveAgentHealth({ name: "plain" })
    expect(withSandbox.checks.sandbox).toEqual({ status: "ready" })
    expect(withSandbox.integrations).toEqual({})
    expect(withoutSandbox.checks.sandbox).toBeUndefined()
  })
})

describe("Agent Sandbox environment", () => {
  it("forwards Driver and provider runtime values but keeps host values on the host", () => {
    expect(providerSandboxEnvironment({
      explicit: ["DRIVER_VALUE", "PATH_OVERRIDE"],
      host: { HOST_SECRET: "host", PATH: "/host/bin", T3_MCP_BEARER_TOKEN: "stale-host-token" },
      prepared: { DRIVER_VALUE: "driver", PATH: "/host/bin", PATH_OVERRIDE: "/driver/bin" },
      received: {
        "BAD-NAME": "value",
        DRIVER_VALUE: "driver",
        HOME: "/host/home",
        HOST_SECRET: "host",
        PATH: "/host/bin",
        PATH_OVERRIDE: "/driver/bin",
        T3_MCP_BEARER_TOKEN: "runtime",
        XDG_CONFIG_HOME: "/host/config",
      },
    })).toEqual({ DRIVER_VALUE: "driver", PATH_OVERRIDE: "/driver/bin", T3_MCP_BEARER_TOKEN: "runtime" })
  })

  it("reports boxed provider inspection as unsupported", async () => {
    const agent = defineAgent({ sandbox: { runtime: "trusted-host" }, driver: { kind: "codex" } })
    expect(await agent.status?.({ runtime: "unknown", memo: vi.fn(), waitUntil: vi.fn() })).toMatchObject({
      readiness: "unsupported",
      reason: "Provider inspection inside an Agent Sandbox is not supported.",
    })
  })

  it("identifies runtimes that share the ViteHub network", () => {
    expect(sandboxSharesHostNetwork("trusted-host")).toBe(true)
    expect(sandboxSharesHostNetwork({ kind: "trusted-host" })).toBe(true)
    expect(sandboxSharesHostNetwork({ kind: "crabbox", network: "direct" })).toBe(true)
    expect(sandboxSharesHostNetwork({ kind: "crabbox", profile: "remote" })).toBe(false)
    expect(sandboxSharesHostNetwork("crabbox")).toBe(false)
    const custom = { name: "ssh", open: vi.fn(), prepare: vi.fn() }
    expect(sandboxSharesHostNetwork({ ...custom, network: "direct" })).toBe(true)
    expect(sandboxSharesHostNetwork(custom)).toBe(false)
  })
})

describe("Agent Sandbox relay", () => {
  it("rejects host Capability tools in a Sandbox without a shared network before provider startup", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const runtime = providerRuntime("sandbox-isolated-tools", async () => undefined)
    const context = {
      ...invocationContext("sandbox-isolated-tools", { prompt: "repair", options: { ref: "refs/heads/first", sha: first, token: "token" } }),
      tools: { repair: { name: "repair", description: "Host repair", inputSchema: { type: "object" }, execute: vi.fn() } },
    }
    await expect(createProviderAgentAdapter<PullRequestOptions>({
      sandbox: { ...testSandbox(repository), runtime: { kind: "crabbox", profile: "remote" } },
      provider: "codex",
      permissions: "allow-edits-unattended",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(context as never)).rejects.toMatchObject({ code: "AGENT_R0961" })
    expect(runtime.startSession).not.toHaveBeenCalled()
    expect(openedSandboxSession.current).toBeUndefined()
  })
  it("materializes nested pull request Skills in Sandbox Home", async () => {
    const threadId = "thread-nested-pull-request-provider-root"
    let root = ""
    providerRuntime(threadId, async ({ cwd }) => {
      expect(cwd).toBe(join(root, "portal"))
      const result = await openedSandboxSession.current!.exec("sh", ["-c", 'cat "$HOME/.codex/skills/review/SKILL.md"'])
      expect(result.stdout).toBe("review skill")
      expect(result.ok).toBe(true)
      const options = createProviderRuntime.mock.lastCall?.[0]
      const launched = await runLauncher(String(options?.settings?.binaryPath), ["-e", "process.stdout.write(process.cwd())"], {
        cwd,
        env: { ...options?.environment },
        stdin: "",
      })
      expect(launched).toMatchObject({ code: 0 })
      expect(launched.stdout).toBe(await realpath(join(openedSandboxSession.current!.cwd, "portal")))
    })
    const session = {
      close: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      diff: vi.fn(async () => ({ entries: [] })),
      exec: vi.fn(async (command: string, args: string[] = [], options?: { cwd?: string }) => {
        const cwd = options?.cwd?.replace(/^\/workspace/, root) || root
        const result = spawnSync(command, args, { cwd, encoding: "utf8" })
        return { args, command, exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout }
      }),
      readFile: vi.fn(async () => new Uint8Array()),
    }
    const workspace = {
      fs: {},
      startSession: vi.fn(async (options: { target: string }) => {
        root = options.target
        const checkout = join(root, "portal")
        await mkdir(checkout)
        const git = (...args: string[]) => {
          const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
          if (result.status !== 0) throw new Error(result.stderr)
          return result.stdout
        }
        git("init", "-q", "-b", "feature")
        git("remote", "add", "origin", "https://github.com/acme/portal.git")
        git("config", "branch.feature.remote", "origin")
        git("config", "branch.feature.merge", "refs/heads/feature")
        git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "initial repository")
        runContext.context.set("pullRequest", {
          pullRequest: {
            head: { ref: "feature", repo: "acme/portal", sha: git("rev-parse", "HEAD").trim() },
            source: { mount: "portal", ref: "refs/pull/42/head", repo: "acme/portal" },
          },
          repository: { fullName: "acme/portal", name: "portal" },
        })
        return session
      }),
      tools: {},
    }
    const runContext = {
      ...invocationContext(threadId, { options: { ref: "feature", sha: "a".repeat(40), token: "test" }, prompt: "hello" }),
      workspace,
      workspaceDefinition: { mode: "write", name: "docs" },
      workspaceMode: "write",
    }
    runContext.context.set("agent.colocatedSkills", {
      review: { content: "review skill", workspacePath: ".agents/skills/review/SKILL.md" },
    })
    runContext.context.set("pullRequest", {
      pullRequest: {
        head: { ref: "feature", repo: "acme/portal", sha: "a".repeat(40) },
        number: 42,
        source: { mount: "portal", ref: "refs/pull/42/head", repo: "acme/portal" },
      },
      repository: { fullName: "acme/portal", name: "portal" },
    })

    await expect(createProviderAgentAdapter({ sandbox: { cwd: () => root, runtime: "trusted-host" }, provider: "codex", providerSettings: { binaryPath: process.execPath } }).generate(runContext as never)).resolves.toMatchObject({ text: "" })
    expect(session.exec.mock.calls.some(([command, args = []]) => command === "git" && args.join(" ") === "init -q")).toBe(true)
  })


  it.each(["relay.mjs", "provider"])("closes the listening server when writing %s fails", async (blockedFile) => {
    const root = await temporaryRoot()
    await mkdir(join(root, blockedFile))
    await expect(startProviderSandboxRelay({
      // SAFETY: Setup fails before this fixture needs a Sandbox process.
      sandbox: { session: { cwd: "/sandbox/work" } } as unknown as ProviderSandboxSession,
      command: "provider",
      diagnosticPath: join(root, "diagnostic.json"),
      environment: () => ({}),
      launchRoot: root,
      localRoot: join(root, "local"),
    })).rejects.toMatchObject({ code: "EISDIR" })
    await vi.waitFor(() => expect(relayServers.at(-1)?.listening).toBe(false))
  })

  it("lets Agent cleanup kill a SIGTERM-resistant provider and sync its Sandbox cwd", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)
    const threadId = "sandbox-resistant-provider"
    let launcher: ReturnType<typeof spawn> | undefined
    let launcherClosed: Promise<unknown> | undefined
    providerRuntime(threadId, async ({ cwd }) => {
      const options = createProviderRuntime.mock.lastCall?.[0]
      const script = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('saved.txt', 'preserved'); process.stdout.write('ready'); setInterval(() => {}, 1000)"
      launcher = spawn(String(options?.settings?.binaryPath), ["-e", script], { cwd, env: { ...options?.environment }, stdio: ["pipe", "pipe", "ignore"] })
      launcherClosed = new Promise(resolve => launcher!.once("close", resolve))
      await once(launcher.stdout!, "data")
    })
    const invocation = createProviderAgentAdapter<PullRequestOptions>({
      sandbox: { cwd: workspace, runtime: "trusted-host" },
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "", sha: "", token: "" } }) as never)
    let finished = false
    let failure: unknown
    const settled = Promise.resolve(invocation).then(() => { finished = true }, (error: unknown) => { failure = error; finished = true })
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2000 })
      expect(failure).toBeUndefined()
      expect(await readFile(join(workspace, "saved.txt"), "utf8")).toBe("preserved")
      await launcherClosed
    }
    finally {
      await openedSandboxSession.current?.close()
      await settled
      launcher?.kill("SIGKILL")
      await launcherClosed
    }
  })

  it("stops pulling Sandbox output while the runtime consumer is paused", async () => {
    const root = await temporaryRoot()
    const totalChunks = 256
    let pulled = 0
    let output: ReadableStreamDefaultController<Uint8Array> | undefined
    let finish: ((exit: { code: number }) => void) | undefined
    const exited = new Promise<{ code: number }>(resolve => finish = resolve)
    const child = {
      kill: async () => {
        if (pulled < totalChunks) output?.close()
        finish?.({ code: 0 })
      },
      stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({
        start: controller => output = controller,
        pull: (controller) => {
          controller.enqueue(new Uint8Array(64 * 1024))
          pulled++
          if (pulled === totalChunks) {
            controller.close()
            finish?.({ code: 0 })
          }
        },
      }),
      wait: () => exited,
    }
    const relay = await startProviderSandboxRelay({
      // SAFETY: The fixture supplies the Sandbox cwd and process streams used by the relay.
      sandbox: { session: { cwd: "/sandbox/work" }, spawn: async () => child } as unknown as ProviderSandboxSession,
      command: "provider",
      diagnosticPath: join(root, "diagnostic.json"),
      environment: () => ({}),
      launchRoot: root,
      localRoot: join(root, "local"),
    })
    const launcher = spawn(relay.launcher, [], { stdio: ["pipe", "pipe", "ignore"] })
    const closed = new Promise<number | null>(resolve => launcher.once("close", resolve))
    try {
      launcher.stdin.end()
      await vi.waitFor(() => expect(pulled).toBeGreaterThan(1))
      await new Promise(resolve => setTimeout(resolve, 100))
      const pausedCount = pulled
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(pulled).toBe(pausedCount)
      expect(pulled).toBeLessThan(totalChunks)
      launcher.stdout.resume()
      expect(await closed).toBe(0)
      expect(pulled).toBe(totalChunks)
    }
    finally {
      launcher.kill("SIGKILL")
      await relay.close()
      await closed
    }
  })

  it("stops a Sandbox process that starts after its relay connection closed", async () => {
    const root = await temporaryRoot()
    let started: (() => void) | undefined
    const spawnCalled = new Promise<void>(resolve => started = resolve)
    let finishSpawn: (() => void) | undefined
    const spawnReleased = new Promise<void>(resolve => finishSpawn = resolve)
    const kill = vi.fn(async () => undefined)
    const child = {
      kill,
      stderr: new ReadableStream<Uint8Array>(),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      wait: () => new Promise<{ code: number }>(() => undefined),
    }
    const sandbox = {
      home: "/sandbox/home",
      session: { cwd: "/sandbox/work" },
      spawn: async () => {
        started?.()
        await spawnReleased
        return child
      },
    }
    const relay = await startProviderSandboxRelay({
      // SAFETY: The relay reads only the Sandbox cwd and spawn in this fixture.
      sandbox: sandbox as unknown as ProviderSandboxSession,
      command: "provider",
      diagnosticPath: join(root, "diagnostic.json"),
      environment: () => ({}),
      launchRoot: root,
      localRoot: join(root, "local"),
    })
    const launcher = spawn(relay.launcher, [], { stdio: ["pipe", "ignore", "ignore"] })
    const launcherClosed = new Promise(resolve => launcher.once("close", resolve))
    await spawnCalled
    // Closing the relay closes the connection before the Sandbox process exists.
    let closed = false
    const closing = relay.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(closed).toBe(false)
    finishSpawn?.()
    await closing
    await vi.waitFor(() => expect(kill).toHaveBeenCalled())
    launcher.kill("SIGKILL")
    await launcherClosed
  })
})

describe("Agent Sandbox provider execution", () => {
  it("runs the provider from an independent authoritative Sandbox cwd", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)
    await writeFile(join(workspace, "README.md"), "independent checkout\n")
    const threadId = "sandbox-independent-cwd"
    let sibling = ""
    let embedded = ""
    let embeddedPrefix = ""
    let url = ""
    let command = ""
    let atReference = ""
    let quotedPath = ""
    let unicodeSibling = ""
    let plusSibling = ""
    let launched: LauncherResult | undefined
    providerRuntime(threadId, async ({ cwd }) => {
      expect(cwd).not.toBe(workspace)
      sibling = `${cwd}ist/config`
      embedded = `prefix${cwd}suffix`
      embeddedPrefix = `prefixé${cwd}`
      url = `URL=file://${cwd}#section`
      command = `CMD=${cwd}&pwd`
      atReference = `@${cwd}/notes.txt`
      quotedPath = `\`${cwd}/notes.txt\``
      unicodeSibling = `${cwd}é/config`
      plusSibling = `${cwd}+archive/config`
      const options = createProviderRuntime.mock.lastCall?.[0]
      const script = "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1), input, readme: require('node:fs').readFileSync('README.md', 'utf8'), mapped: process.env.PROVIDER_PATH, sibling: process.env.PROVIDER_SIBLING, text: process.env.PROVIDER_TEXT, embeddedPrefix: process.env.PROVIDER_EMBEDDED_PREFIX, url: process.env.PROVIDER_URL, command: process.env.PROVIDER_COMMAND, atReference: process.env.PROVIDER_AT_REFERENCE, quotedPath: process.env.PROVIDER_QUOTED_PATH, unicodeSibling: process.env.PROVIDER_UNICODE_SIBLING, plusSibling: process.env.PROVIDER_PLUS_SIBLING })))"
      launched = await runLauncher(String(options?.settings?.binaryPath), ["-e", script, join(cwd, "notes.txt"), sibling], {
        cwd,
        env: { ...options?.environment, PROVIDER_PATH: join(cwd, "notes.txt"), PROVIDER_SIBLING: sibling, PROVIDER_TEXT: embedded, PROVIDER_EMBEDDED_PREFIX: embeddedPrefix, PROVIDER_URL: url, PROVIDER_COMMAND: command, PROVIDER_AT_REFERENCE: atReference, PROVIDER_QUOTED_PATH: quotedPath, PROVIDER_UNICODE_SIBLING: unicodeSibling, PROVIDER_PLUS_SIBLING: plusSibling },
        stdin: `${cwd}/notes.txt\n${sibling}\n${unicodeSibling}\n${plusSibling}\n${embeddedPrefix}\n${url}\n${command}\n${atReference}\n${quotedPath}\n`,
      })
      expect(launched).toMatchObject({ code: 0 })
      const sandboxCwd = openedSandboxSession.current!.cwd
      expect(JSON.parse(launched.stdout)).toMatchObject({
        argv: [`${sandboxCwd}/notes.txt`, sibling],
        cwd: await realpath(sandboxCwd),
        input: `${sandboxCwd}/notes.txt\n${sibling}\n${unicodeSibling}\n${plusSibling}\n${embeddedPrefix}\nURL=file://${sandboxCwd}#section\nCMD=${sandboxCwd}&pwd\n@${sandboxCwd}/notes.txt\n\`${sandboxCwd}/notes.txt\`\n`,
        mapped: `${sandboxCwd}/notes.txt`,
        readme: "independent checkout\n",
        sibling,
        text: embedded,
        embeddedPrefix,
        url: `URL=file://${sandboxCwd}#section`,
        command: `CMD=${sandboxCwd}&pwd`,
        atReference: `@${sandboxCwd}/notes.txt`,
        quotedPath: `\`${sandboxCwd}/notes.txt\``,
        unicodeSibling,
        plusSibling,
      })
    })
    await expect(createProviderAgentAdapter<PullRequestOptions>({
      sandbox: { cwd: workspace, runtime: "trusted-host" },
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "", sha: "", token: "" } }) as never)).resolves.toMatchObject({ text: "" })
    expect(launched).toMatchObject({ code: 0 })
  })

  it("runs the provider in a Sandbox resolved for each invocation", async () => {
    const root = await temporaryRoot()
    const { first, repository, second } = await gitRepository(root)
    vi.stubEnv("VITEHUB_SANDBOX_TEST_HOST_ONLY", "host")
    const results: Array<{ launched: LauncherResult, localRoot: string }> = []
    const adapter = createProviderAgentAdapter<PullRequestOptions>({
      sandbox: testSandbox(repository),
      env: { DRIVER_VALUE: "driver" },
      instructions: "Follow the Sandbox rules.",
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
    })

    for (const [threadId, ref, sha, token] of [["sandbox-first", "refs/heads/first", first, "token-a"], ["sandbox-second", "refs/heads/main", second, "token-b"]] as const) {
      providerRuntime(threadId, async ({ cwd }) => {
        const options = createProviderRuntime.mock.lastCall?.[0]
        const launcher = String(options?.settings?.binaryPath)
        expect(launcher).not.toBe(process.execPath)
        const launched = await runLauncher(launcher, ["-e", probeScript, join(cwd, "notes.txt")], {
          cwd,
          env: { ...options?.environment, T3_MCP_BEARER_TOKEN: "runtime-token" },
          stdin: `{"path":"${cwd}/notes.txt"}\n`,
        })
        results.push({ launched, localRoot: cwd })
      })
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
      await adapter.generate(invocationContext(threadId, { prompt: "review", options: { ref, sha, token } }) as never)
    }

    expect(results).toHaveLength(2)
    const reports = results.map(({ launched }) => {
      expect(launched).toMatchObject({ code: 0, stderr: "probe stderr\n" })
      return JSON.parse(launched.stdout) as {
        agents: string
        argv: string[]
        config: string
        cwd: string
        env: Record<string, string | undefined>
        home: string
        input: string
        readme: string
      }
    })
    expect(reports.map(report => report.readme)).toEqual(["first\n", "second\n"])
    expect(reports.map(report => report.env.SANDBOX_TOKEN)).toEqual(["token-a", "token-b"])
    expect(reports.map(report => JSON.parse(report.config).sha)).toEqual([first, second])
    for (const [index, report] of reports.entries()) {
      const localRoot = results[index]!.localRoot
      expect(report.agents).toContain("Follow the Sandbox rules.")
      expect(report.env).toMatchObject({ DRIVER_VALUE: "driver", RUNTIME_TOKEN: "runtime-token" })
      expect(report.env.HOST_ONLY).toBeUndefined()
      expect(report.home).not.toBe(process.env.HOME)
      expect(report.cwd).not.toBe(localRoot)
      expect(report.argv).toEqual([`${report.cwd}/notes.txt`])
      expect(report.input).toBe(`{"path":"${report.cwd}/notes.txt"}\n`)
    }
    expect(reports[0]!.cwd).not.toBe(reports[1]!.cwd)
    await expect(readFile(join(reports[0]!.cwd, "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reports the Sandbox provider exit code and stderr as a launch failure", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const threadId = "sandbox-failure"
    let launched: LauncherResult | undefined
    providerRuntime(threadId, async ({ cwd }) => {
      const options = createProviderRuntime.mock.lastCall?.[0]
      launched = await runLauncher(String(options?.settings?.binaryPath), ["-e", "process.stderr.write(process.env.SANDBOX_TOKEN + '\\n'); process.exit(7)"], {
        cwd,
        env: { ...options?.environment },
        stdin: "",
      })
      throw new Error("Codex App Server process exited with code 7")
    })

    await expect(createProviderAgentAdapter<PullRequestOptions>({
      sandbox: { ...testSandbox(repository), home: undefined },
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)).rejects.toMatchObject({
      code: "PROVIDER_LAUNCH_FAILED",
      details: { exitCode: 7, stderr: "[REDACTED]" },
    })
    expect(launched).toMatchObject({ code: 7, stderr: "token\n" })
  })

  it.each(["contents", "from", "seed"] as const)("omits launch diagnostics containing Sandbox Home %s credentials", async (source) => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const secret = "private-home-credential"
    const sourceRoot = await mkdtemp(join(process.cwd(), ".sandbox-home-test-"))
    roots.push(sourceRoot)
    const sourcePath = join(sourceRoot, "credentials")
    await writeFile(sourcePath, secret)
    const file = source === "from" ? { from: relative(process.cwd(), sourcePath) } : { contents: async () => secret }
    const home: NonNullable<TestSandbox["home"]> = source === "seed"
      ? { state: { ".config": { key: crypto.randomUUID(), seed: { credentials: file } } } }
      : { files: { ".config/credentials": file } }
    const threadId = `sandbox-home-failure-${source}`
    let launched: LauncherResult | undefined
    providerRuntime(threadId, async ({ cwd }) => {
      const options = createProviderRuntime.mock.lastCall?.[0]
      launched = await runLauncher(String(options?.settings?.binaryPath), ["-e", "process.stderr.write(require('node:fs').readFileSync(process.env.HOME + '/.config/credentials')); process.exit(7)"], {
        cwd,
        env: { ...options?.environment },
        stdin: "",
      })
      throw new Error("Codex App Server process exited with code 7")
    })
    await expect(createProviderAgentAdapter<PullRequestOptions>({
      sandbox: { ...testSandbox(repository), home, runtime: { kind: "trusted-host", stateRoot: join(root, "state") } },
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)).rejects.toMatchObject({
      code: "PROVIDER_LAUNCH_FAILED",
      details: { exitCode: 7, stderr: "[Sandbox Home diagnostic output omitted]" },
    })
    expect(launched).toMatchObject({ code: 7, stderr: secret })
  })

  it("checks Sandbox requirements before the provider starts", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const runtime = providerRuntime("sandbox-requires", async () => undefined)

    await expect(createProviderAgentAdapter<PullRequestOptions>({
      sandbox: testSandbox(repository, ["vitehub-missing-sandbox-command"]),
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext("sandbox-requires", { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)).rejects.toThrow("vitehub-missing-sandbox-command")
    expect(runtime.startSession).not.toHaveBeenCalled()
  })

  it("ends the relay when the Sandbox provider exits while its input stays open", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const threadId = "sandbox-open-input"
    let launched: LauncherResult | undefined
    providerRuntime(threadId, async ({ cwd }) => {
      const options = createProviderRuntime.mock.lastCall?.[0]
      launched = await runLauncher(String(options?.settings?.binaryPath), ["-e", "process.stdout.write('done\\n'); process.exit(0)"], {
        cwd,
        env: { ...options?.environment },
        keepStdinOpen: true,
        stdin: "{\"id\":1}\n",
      })
    })

    await createProviderAgentAdapter<PullRequestOptions>({
      sandbox: testSandbox(repository),
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)
    expect(launched).toMatchObject({ code: 0, stdout: "done\n" })
  })

  it("fails the invocation when the Sandbox session cannot close", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const threadId = "sandbox-close-failure"
    sandboxCloseFailure.error = new Error("Sandbox cwd synchronization failed")
    const runtime = providerRuntime(threadId, async () => undefined)

    const invocation = createProviderAgentAdapter<PullRequestOptions>({
      sandbox: testSandbox(repository),
      provider: "codex",
      providerSettings: { binaryPath: process.execPath },
      // SAFETY: The fixture provides the provider invocation fields read by the adapter.
    }).generate(invocationContext(threadId, { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)
    await expect(invocation).rejects.toBeInstanceOf(AggregateError)
    await expect(invocation).rejects.toMatchObject({ errors: expect.arrayContaining([sandboxCloseFailure.error]) })
    expect(runtime.startSession).toHaveBeenCalled()
  })

  it("rejects Sandbox execution on Windows hosts before the Sandbox opens", async () => {
    const root = await temporaryRoot()
    const { first, repository } = await gitRepository(root)
    const runtime = providerRuntime("sandbox-windows", async () => undefined)
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    try {
      await expect(createProviderAgentAdapter<PullRequestOptions>({
        sandbox: testSandbox(repository),
        provider: "codex",
        providerSettings: { binaryPath: process.execPath },
        // SAFETY: The fixture provides the provider invocation fields read by the adapter.
      }).generate(invocationContext("sandbox-windows", { prompt: "review", options: { ref: "refs/heads/first", sha: first, token: "token" } }) as never)).rejects.toMatchObject({
        code: "AGENT_R0963",
        message: expect.stringContaining("POSIX Node host"),
      })
    }
    finally {
      Object.defineProperty(process, "platform", platform)
    }
    expect(runtime.startSession).not.toHaveBeenCalled()
  })
})
