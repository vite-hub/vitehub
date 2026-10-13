import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: { cwd?: string, environment?: Record<string, string> }) => providerRuntime()))
const inspectProvider = vi.hoisted(() => vi.fn())
const prepareHostToolchain = vi.hoisted(() => vi.fn())
vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime, createSqliteProviderRuntimeSessionStore: vi.fn(), inspectProvider }))
vi.mock("../src/internal/provider-runtime-packages.ts", () => ({ resolveInstalledProviderExecutable: () => "/fake/codex" }))
vi.mock("@vite-hub/box/_internal/toolchain", () => ({ prepareHostToolchain }))

import { defineAgent } from "../src/index.ts"
import { createProviderAgentAdapter, inspectAgentProvider, localWorkspaceHost } from "../src/provider-agent.ts"
import { executeWorkspaceCommand } from "../src/capabilities/workspace-command.ts"
import { provideBrowserRuntimeEnvironment } from "../src/internal/browser-runtime.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function providerRuntime() {
  const threadId = "thread-toolchain"
  return {
    attachmentsDirectory: join(tmpdir(), `attachments-${crypto.randomUUID()}`),
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        yield { payload: { state: "completed" }, threadId, turnId: "turn-1", type: "turn.completed" }
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => ({ threadId, turnId: "turn-1" })),
    startSession: vi.fn(async () => ({ threadId })),
    stopSession: vi.fn(async () => undefined),
  }
}

function context() {
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
      run: { runId: "run-toolchain", threadId: "thread-toolchain" },
      runtime: "vite",
      runtimeConfig: {},
      waitUntil: () => undefined,
    },
  }
}

async function toolchainBin() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-provider-toolchain-"))
  roots.push(root)
  const bin = join(root, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "node"), "#!/bin/sh\necho v22.1.0-toolchain\n")
  await chmod(join(bin, "node"), 0o755)
  return { bin, root }
}

describe("driver.toolchain", () => {
  it("provisions from the provider checkout and puts the toolchain first on the provider PATH", async () => {
    const { bin, root } = await toolchainBin()
    const checkout = join(root, "checkout")
    await mkdir(checkout)
    prepareHostToolchain.mockResolvedValue({ bin: [bin], node: { source: ".node-version", version: "22.1.0" } })

    await createProviderAgentAdapter({
      cwd: checkout,
      env: { PATH: "/caller/bin" },
      provider: "codex",
      toolchain: "project",
    }).generate(context() as never)

    expect(prepareHostToolchain).toHaveBeenCalledWith("project", checkout, expect.objectContaining({ abortSignal: undefined }))
    expect(createProviderRuntime.mock.lastCall?.[0].environment?.PATH).toBe(`${bin}${delimiter}/caller/bin`)
  })

  it("does not provision for providers without a toolchain", async () => {
    const { root } = await toolchainBin()
    await createProviderAgentAdapter({ cwd: root, env: { PATH: "/caller/bin" }, provider: "codex" }).generate(context() as never)
    expect(prepareHostToolchain).not.toHaveBeenCalled()
    expect(createProviderRuntime.mock.lastCall?.[0].environment?.PATH).toBe("/caller/bin")
  })

  it("runs Workspace commands with the toolchain before the host node", async () => {
    const { bin } = await toolchainBin()
    const path: string[] = []
    const host = localWorkspaceHost({ path })
    const before = await host.exec("node", ["-v"])
    path.push(bin)
    const after = await host.exec("node", ["-v"])
    expect(before.stdout.trim()).toBe(process.version)
    expect(after.stdout.trim()).toBe("v22.1.0-toolchain")
  })

  it.each([false, true])("keeps managed browser commands before toolchain binaries with in-place %s", async (inPlace) => {
    const { bin, root } = await toolchainBin()
    const managed = join(root, "managed")
    await mkdir(managed)
    for (const [directory, output] of [[managed, "managed"], [bin, "toolchain"]]) {
      await writeFile(join(directory!, "agent-browser"), `#!/bin/sh\necho ${output}\n`, { mode: 0o755 })
    }
    prepareHostToolchain.mockResolvedValue({ bin: [bin] })
    const workspace = {
      fs: {},
      tools: {},
      startSession: async (options: import("@vite-hub/workspace").WorkspaceSessionOptions) => ({
        close: async () => undefined,
        commit: async () => undefined,
        diff: async () => ({ entries: [] }),
        readFile: async () => new Uint8Array(),
        exec: async (command: string, args: string[] = [], execOptions?: { env?: Record<string, string> }) => {
          const result = await options.host!.exec(command, args, { cwd: options.target, env: execOptions?.env })
          return { args, command, exitCode: result.code, stderr: result.stderr, stdout: result.stdout }
        },
      }),
    }
    const runContext = { ...context(), workspace, workspaceDefinition: { mode: "write", name: "test" }, workspaceMode: "write" }
    provideBrowserRuntimeEnvironment(runContext.context as never, { PATH: managed, VITEHUB_BROWSER_ACTIVE: "1" })
    const provider = providerRuntime()
    provider.sendTurn.mockImplementation(async () => {
      const result = await executeWorkspaceCommand(workspace, "agent-browser", [], {}, runContext.context as never)
      expect(result.stdout.trim()).toBe("managed")
      const node = await executeWorkspaceCommand(workspace, "node", ["-v"], {}, runContext.context as never)
      expect(node.stdout.trim()).toBe("v22.1.0-toolchain")
      return { threadId: "thread-toolchain", turnId: "turn-1" }
    })
    createProviderRuntime.mockResolvedValueOnce(provider)
    await createProviderAgentAdapter({ ...(inPlace ? { cwd: root } : {}), provider: "codex", toolchain: "project" }).generate(runContext as never)
  })

  it("does not report toolchain commands as missing before a checkout exists", async () => {
    inspectProvider.mockResolvedValue({ enabled: true, installed: true, status: "ready", version: "1", checkedAt: new Date().toISOString(), auth: { status: "authenticated" } })
    const status = await inspectAgentProvider({
      provider: "codex",
      requirements: ["node", "pnpm", "pnpx", "yarn", "yarnpkg", "vitehub-missing-command"],
      toolchain: "project",
    }, {
      agentIdentity: { name: "bot" },
      capabilities: {},
      context: createAgentInvocationContextStore(),
      memo: (_key, create) => create(),
      purpose: "inspection",
      runtime: "unknown",
      waitUntil: () => undefined,
    })
    expect(status.missingCommands).toEqual(["vitehub-missing-command"])
  })

  it("validates the declaration and rejects it with a Box", () => {
    expect(() => defineAgent({
      driver: { kind: "codex", permissions: "allow-all", toolchain: { node: 22 } as never },
      name: "invalid-toolchain",
    })).toThrow(expect.objectContaining({ code: "AGENT_R0971" }))
    expect(() => defineAgent({
      box: { runtime: "trusted-host", toolchain: "project" },
      driver: { kind: "codex", permissions: "allow-all", toolchain: "project" },
      name: "box-toolchain",
    })).toThrow(expect.objectContaining({ code: "AGENT_R0972" }))
  })
})
