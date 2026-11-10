import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

// SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const durableProviderSessionCursors = vi.hoisted(() => new Map<string, Map<string, unknown>>())
interface MockProviderSessionStore {
  delete: (threadId: string) => Promise<void>
  get: (threadId: string) => Promise<unknown | undefined>
  set: (threadId: string, resumeCursor: unknown) => Promise<void>
}
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: { cwd?: string, environment?: Record<string, string>, sessionStore?: MockProviderSessionStore, settings?: Record<string, unknown> }) => providerRuntimes.shift()))
const createSqliteProviderRuntimeSessionStore = vi.hoisted(() => vi.fn(async (path: string) => {
  let cursors = durableProviderSessionCursors.get(path)
  if (!cursors) {
    cursors = new Map()
    durableProviderSessionCursors.set(path, cursors)
  }
  return {
    close: vi.fn(),
    delete: vi.fn(async (threadId: string) => {
      cursors.delete(threadId)
    }),
    get: vi.fn(async (threadId: string) => cursors.get(threadId)),
    path,
    set: vi.fn(async (threadId: string, resumeCursor: unknown) => {
      cursors.set(threadId, resumeCursor)
    }),
  }
}))

function lastProviderSessionStore(): MockProviderSessionStore {
  const store = createProviderRuntime.mock.lastCall?.[0].sessionStore
  if (!store) throw new Error("Expected the provider runtime to receive a session store.")
  return store
}

async function lastDurableProviderSessionStore() {
  const result = createSqliteProviderRuntimeSessionStore.mock.results.at(-1)
  if (!result) throw new Error("Expected a durable provider session store.")
  return await result.value
}

const resolveInstalledProviderExecutable = vi.hoisted(() => vi.fn<(provider: "claude-code" | "codex") => string | undefined>(provider => provider === "codex"
  ? "/app/node_modules/@openai/codex/bin/codex.js"
  : "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"))

vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime, createSqliteProviderRuntimeSessionStore }))
vi.mock("../../agent/src/internal/provider-runtime-packages.ts", () => ({ resolveInstalledProviderExecutable }))
// Launch failure tests expect one attempt. The retry test sets short delays.
const providerLaunchRetry = vi.hoisted(() => ({ delaysMs: [] as number[] }))
vi.mock("../../agent/src/internal/provider-launch-retry.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../agent/src/internal/provider-launch-retry.ts")>(),
  get providerLaunchRetryDelaysMs() { return providerLaunchRetry.delaysMs },
}))

import { createProviderAgentAdapter } from "../../agent/src/provider-agent.ts"
import { chatgpt } from "@vite-hub/gateways"
import { prepareGitHubPullRequestWorkspace } from "../src/github/checkout.ts"
import { commitGitHubPullRequestWorkspace, prepareGitHubRepairBase } from "../src/github/repair.ts"

/** The `developer_instructions` value of the last Codex launch, as Codex parses it. */
function launchedCodexDeveloperInstructions(): string | undefined {
  const [, value] = /-c "developer_instructions=((?:[^"\\]|\\.)*)"/.exec(String(createProviderRuntime.mock.lastCall?.[0].settings?.launchArgs)) ?? []
  // The runtime unescapes these characters inside a double-quoted argument. Codex parses the result as TOML.
  return value === undefined ? undefined : JSON.parse(value.replace(/\\(["\\$`])/g, "$1"))
}

function event(type: string, threadId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { payload, threadId, type, ...extra }
}

function runtime(threadId: string, events: unknown[], options: {
  afterEvents?: () => Promise<void>
  onSendTurn?: (mcp: { authorizationHeader: string, endpoint: string } | undefined) => Promise<void>
  onStartSession?: (input: { mcp?: { authorizationHeader: string, endpoint: string } }) => Promise<void>
  beforeEvent?: (index: number) => Promise<void>
  resumeCursor?: unknown
  turnResumeCursor?: unknown
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
      mcp = input.mcp
      await options.onStartSession?.(input)
      // Model the launcher's consumption of the private thread configuration.
      if (mcp?.endpoint === "http://127.0.0.1/vitehub-chatgpt-configuration") {
        const configuration = JSON.parse(mcp.authorizationHeader).mcp
        mcp = configuration ? { endpoint: configuration.url, authorizationHeader: configuration.http_headers.Authorization } : undefined
      }
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

describe("Provider Agent Driver with a host-prepared GitHub checkout", () => {
  it.each([
    { provider: "codex" as const, merge: false },
    { provider: "codex" as const, merge: true },
    { provider: "claude-code" as const, merge: false },
    { provider: "claude-code" as const, merge: true },
  ])("preserves a $provider checkout restored by launch in an owned Workspace, merge=$merge", async ({ provider, merge }) => {
    const source = await mkdtemp(join(tmpdir(), "vitehub-launch-checkout-"))
    let root = ""
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    try {
      git(source, "init", "-q", "-b", "main")
      git(source, "config", "user.name", "Test")
      git(source, "config", "user.email", "test@localhost")
      git(source, "remote", "add", "origin", "https://github.com/acme/portal.git")
      await writeFile(join(source, "AGENTS.md"), "native instructions")
      await writeFile(join(source, "CLAUDE.md"), "native Claude instructions")
      await writeFile(join(source, "file.txt"), "original\n")
      git(source, "add", "-A")
      git(source, "commit", "-qm", "initial")
      git(source, "branch", "feature")
      await writeFile(join(source, "file.txt"), "base edit\n")
      git(source, "add", "-A")
      git(source, "commit", "-qm", "base change")
      const base = git(source, "rev-parse", "HEAD")
      git(source, "checkout", "-q", "feature")
      await writeFile(join(source, "file.txt"), "PR edit\n")
      git(source, "add", "-A")
      git(source, "commit", "-qm", "PR change")
      const expectedHead = git(source, "rev-parse", "HEAD")
      const session = {
        close: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        diff: vi.fn(async () => ({ entries: [] })),
        exec: vi.fn(async (command: string, args: string[] = []) => {
          const result = spawnSync(command, args, { cwd: root, encoding: "utf8" })
          return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout }
        }),
        readFile: vi.fn(async () => new Uint8Array()),
      }
      const workspace = {
        fs: {},
        tools: {},
        startSession: vi.fn(async ({ target }: { target: string }) => {
          root = target
          await writeFile(join(root, "file.txt"), "PR edit\n")
          return session
        }),
      }
      const threadId = `thread-launch-checkout-${provider}-${merge}`
      runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
        async onSendTurn() {
          await writeFile(join(root, "file.txt"), "repaired\n")
          const repairedHead = await commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead })
          expect(git(root, "rev-parse", `${repairedHead}^1`)).toBe(expectedHead)
          if (merge) expect(git(root, "rev-parse", `${repairedHead}^2`)).toBe(base)
          expect(git(root, "log", "--format=%s")).not.toContain("vitehub provider baseline")
          expect(git(root, "show", "HEAD:AGENTS.md")).toBe("native instructions")
          expect(git(root, "show", "HEAD:CLAUDE.md")).toBe("native Claude instructions")
          expect(git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("vitehub-system-prompt")
          expect(git(root, "show", "HEAD:file.txt")).toBe("repaired")
        },
      })
      await createProviderAgentAdapter({
        instructions: "generated repair instructions",
        launch: async ({ command, cwd }) => {
          expect(cwd).toBe(root)
          await prepareGitHubPullRequestWorkspace(source, root, { restoreInstructions: true })
          if (merge) await prepareGitHubRepairBase(root, { expectedHead, base })
          return { command }
        },
        provider,
      }).generate(context(threadId, { workspace, workspaceDefinition: { mode: "write", name: "repair" }, workspaceMode: "write" }) as never)
      expect(session.exec.mock.calls.some(([command, args = []]) => command === "git" && args.includes("vitehub provider baseline"))).toBe(false)
    }
    finally {
      await rm(source, { recursive: true, force: true })
    }
  })

  it.each([
    { provider: "codex", instructions: "generated repair instructions", nativeOverride: false },
    { provider: "codex", instructions: "generated repair instructions".repeat(1400), nativeOverride: false },
    { provider: "codex", instructions: "generated repair instructions".repeat(1400), nativeOverride: true },
    { provider: "claude-code", instructions: "generated repair instructions", nativeOverride: false },
  ] as const)("repairs conflicted $provider instruction files without committing generated instructions", async ({ provider, instructions, nativeOverride }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-conflicted-instructions-"))
    const threadId = `thread-conflicted-instructions-${provider}`
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    }
    try {
      git("init", "-q", "-b", "target")
      git("config", "user.name", "Test")
      git("config", "user.email", "test@localhost")
      for (const name of ["AGENTS.md", "CLAUDE.md"]) await writeFile(join(root, name), "original\n")
      if (nativeOverride) await writeFile(join(root, "AGENTS.override.md"), "native override\n")
      git("add", "-A"); git("commit", "-qm", "initial")
      git("branch", "feature")
      for (const name of ["AGENTS.md", "CLAUDE.md"]) await writeFile(join(root, name), "target instructions\n")
      git("commit", "-qam", "target")
      const base = git("rev-parse", "HEAD").trim()
      git("checkout", "-q", "feature")
      for (const name of ["AGENTS.md", "CLAUDE.md"]) await writeFile(join(root, name), "feature instructions\n")
      git("commit", "-qam", "feature")
      const head = git("rev-parse", "HEAD").trim()
      const session = runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], {
        async onSendTurn() {
          expect(git("diff", "--name-only", "--diff-filter=U")).toBe("AGENTS.md\nCLAUDE.md\n")
          for (const name of ["AGENTS.md", "CLAUDE.md"]) {
            expect(await readFile(join(root, name), "utf8")).toContain("<<<<<<<")
            await writeFile(join(root, name), "resolved source instructions\n")
          }
          if (provider === "codex" && instructions.length < 32768) expect(launchedCodexDeveloperInstructions()).toBe(instructions)
          else if (provider === "codex") expect(session.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: expect.stringContaining(instructions) }))
          else expect(await readFile(join(root, ".claude/vitehub-system-prompt.md"), "utf8")).toBe(instructions)
          if (nativeOverride) {
            expect(await readFile(join(root, "AGENTS.override.md"), "utf8")).toBe("native override\n")
            await writeFile(join(root, "AGENTS.override.md"), "updated native override\n")
          }
          git("add", "-A"); git("commit", "-qm", "resolve instructions")
          expect(git("rev-parse", "HEAD^1").trim()).toBe(head)
          expect(git("rev-parse", "HEAD^2").trim()).toBe(base)
          if (nativeOverride) expect(git("show", "HEAD:AGENTS.override.md")).toBe("updated native override\n")
          else expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("AGENTS.override.md")
          expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("vitehub-system-prompt")
        },
      })
      await createProviderAgentAdapter({
        cwd: root,
        instructions,
        launch: async ({ command }) => {
          await prepareGitHubRepairBase(root, { expectedHead: head, base })
          return { command }
        },
        provider,
      }).generate(context(threadId) as never)
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        expect(await readFile(join(root, name), "utf8")).toBe("resolved source instructions\n")
        expect(git("show", `HEAD:${name}`)).toBe("resolved source instructions\n")
      }
      if (nativeOverride) expect(await readFile(join(root, "AGENTS.override.md"), "utf8")).toBe("updated native override\n")
      expect(git("status", "--porcelain")).toBe("")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(["AGENTS.md", "AGENTS.override.md"])("invalidates a conflicted Codex session when preserved %s changes", async (file) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-conflicted-resume-"))
    const threadId = `thread-conflicted-resume-${crypto.randomUUID()}`
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    }
    try {
      git("init", "-q", "-b", "target")
      git("config", "user.name", "Test")
      git("config", "user.email", "test@localhost")
      await writeFile(join(root, "AGENTS.md"), "original\n")
      await writeFile(join(root, "AGENTS.override.md"), "native override\n")
      git("add", "-A"); git("commit", "-qm", "initial")
      git("branch", "feature")
      await writeFile(join(root, "AGENTS.md"), "target instructions\n")
      git("commit", "-qam", "target")
      const base = git("rev-parse", "HEAD").trim()
      git("checkout", "-q", "feature")
      await writeFile(join(root, "AGENTS.md"), "feature instructions\n")
      git("commit", "-qam", "feature")
      await prepareGitHubRepairBase(root, { expectedHead: git("rev-parse", "HEAD").trim(), base })
      const messages = [
        { parts: [{ text: "previous question", type: "text" }], role: "user" },
        { parts: [{ text: "previous answer", type: "text" }], role: "assistant" },
        { parts: [{ text: "continue", type: "text" }], role: "user" },
      ]
      const generate = () => createProviderAgentAdapter({
        cwd: root,
        instructions: "generated repair instructions".repeat(1400),
        provider: "codex",
        sessionStorePath: `.vitehub/${threadId}.sqlite`,
      }).generate(context(threadId, { messages, prompt: "continue" }) as never)
      const turn = (cursor: string) => runtime(threadId, [event("turn.completed", threadId, { state: "completed" }, { turnId: "turn-1" })], { turnResumeCursor: cursor })
      turn("cursor-1")
      await generate()
      const unchanged = turn("cursor-2")
      await generate()
      expect(unchanged.startSession).toHaveBeenCalledWith(expect.objectContaining({ resumeCursor: "cursor-1" }))

      await writeFile(join(root, file), "updated native instructions\n")
      const changed = turn("cursor-3")
      await generate()
      expect(changed.startSession).toHaveBeenCalledWith(expect.not.objectContaining({ resumeCursor: expect.anything() }))
      expect(changed.sendTurn).toHaveBeenCalledWith(expect.objectContaining({ input: expect.stringContaining("previous answer") }))
      expect(await readFile(join(root, file), "utf8")).toBe("updated native instructions\n")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
