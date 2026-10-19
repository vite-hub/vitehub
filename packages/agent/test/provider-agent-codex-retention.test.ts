import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// SAFETY: This test fixture constructs the provider runtime contract that the adapter uses.
const providerRuntimes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const createProviderRuntime = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => providerRuntimes.shift()))
vi.mock("@t3tools/provider-runtime", () => ({ createProviderRuntime, createSqliteProviderRuntimeSessionStore: vi.fn() }))
vi.mock("../src/internal/provider-runtime-packages.ts", () => ({ resolveInstalledProviderExecutable: () => "/app/node_modules/@openai/codex/bin/codex.js" }))

import { createProviderAgentAdapter } from "../src/provider-agent.ts"
import { codexHomeRetentionIdle, resetCodexHomeRetention, startCodexHomeRetention } from "../src/internal/codex-home-retention.ts"

import type { CodexHomeRetentionSource } from "../src/internal/codex-home-retention.ts"
import type { NormalizedRetention } from "../src/internal/retention-policy.ts"

const day = 86_400_000
const minute = 60_000
const start = Date.parse("2026-10-19T12:00:00.000Z")
const noLimits: NormalizedRetention = { maxAgeMs: false, maxRecords: false, maxSize: false }

let root: string
let home: string

function nativeId(index: number): string {
  return `01a15300-0000-7000-8000-${String(index).padStart(12, "0")}`
}

function cursor(index: number) {
  return { providerThread: { nativeThreadRef: { nativeId: nativeId(index) } } }
}

async function rollout(index: number, ageMs: number): Promise<string> {
  const created = new Date(Date.now() - ageMs)
  const iso = created.toISOString()
  const path = join(home, "sessions", iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), `rollout-${iso.slice(0, 19).replaceAll(":", "-")}-${nativeId(index)}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ payload: { id: nativeId(index) }, type: "session_meta" })}\n`)
  await utimes(path, created, created)
  return path
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

function runtime(threadId: string, resumeCursor: unknown) {
  const value = {
    attachmentsDirectory: join(root, `attachments-${crypto.randomUUID()}`),
    close: vi.fn(async () => undefined),
    events: {
      async *[Symbol.asyncIterator]() {
        yield { payload: { state: "completed" }, threadId, turnId: "turn-1", type: "turn.completed" }
      },
    },
    interruptTurn: vi.fn(async () => undefined),
    respondToRequest: vi.fn(async () => undefined),
    respondToUserInput: vi.fn(async () => undefined),
    sendTurn: vi.fn(async () => ({ resumeCursor, threadId, turnId: "turn-1" })),
    startSession: vi.fn(async (_input: { resumeCursor?: unknown }) => ({ resumeCursor, threadId })),
    stopSession: vi.fn(async () => undefined),
  }
  providerRuntimes.push(value)
  return value
}

function context(threadId: string) {
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
      run: { runId: `run-${crypto.randomUUID()}`, threadId },
      runtime: "vite",
      runtimeConfig: {},
      waitUntil: () => undefined,
    },
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(start)
  root = await mkdtemp(join(tmpdir(), "vitehub-codex-retention-adapter-"))
  home = join(root, "codex")
  await mkdir(home)
  resetCodexHomeRetention()
  providerRuntimes.length = 0
  vi.spyOn(console, "info").mockImplementation(() => undefined)
})

afterEach(async () => {
  await codexHomeRetentionIdle()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(root, { force: true, recursive: true })
})

describe("Codex Driver retention", () => {
  it("prunes in the background at most every 10 minutes and protects the resumed session", async () => {
    const adapter = createProviderAgentAdapter({ provider: "codex", providerSettings: { homePath: home }, retention: { ...noLimits, maxRecords: 1 } })
    const resumed = await rollout(1, 20 * day)
    const first = runtime("chat", cursor(1))
    // SAFETY: The fixture provides the adapter run context fields that the provider Driver reads.
    await adapter.generate(context("chat") as never)
    await codexHomeRetentionIdle(home)
    expect(first.startSession.mock.calls[0]![0].resumeCursor).toBeUndefined()
    expect(await exists(resumed)).toBe(true)

    const newer = await rollout(2, day)
    const newest = await rollout(3, 2 * day)
    vi.setSystemTime(start + 5 * minute)
    const second = runtime("chat", cursor(1))
    // SAFETY: See above.
    await adapter.generate(context("chat") as never)
    await codexHomeRetentionIdle(home)
    expect(second.startSession.mock.calls[0]![0].resumeCursor).toEqual(cursor(1))
    expect([await exists(newer), await exists(newest)]).toEqual([true, true])

    vi.setSystemTime(start + 11 * minute)
    runtime("chat", cursor(1))
    // SAFETY: See above.
    await adapter.generate(context("chat") as never)
    await codexHomeRetentionIdle(home)
    expect([await exists(resumed), await exists(newer), await exists(newest)]).toEqual([true, false, false])
  })

  it("drops the cursor of a referenced session that retention removed, so the next run starts fresh", async () => {
    const resumed = await rollout(1, 20 * day)
    const keeper = createProviderAgentAdapter({ provider: "codex", providerSettings: { homePath: home }, retention: { ...noLimits, maxRecords: 5 } })
    runtime("chat", cursor(1))
    // SAFETY: See above.
    await keeper.generate(context("chat") as never)
    await codexHomeRetentionIdle(home)
    expect(await exists(resumed)).toBe(true)

    // Another Agent on the same home sets a stricter limit. The strictest value of each limit applies.
    const strict = createProviderAgentAdapter({ env: { CODEX_HOME: home }, provider: "codex", retention: { ...noLimits, maxSize: { bytes: 1 } } })
    vi.setSystemTime(start + 11 * minute)
    runtime("other", undefined)
    // SAFETY: See above.
    await strict.generate(context("other") as never)
    await codexHomeRetentionIdle(home)
    expect(await exists(resumed)).toBe(false)
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("different driver.retention policies"))

    const next = runtime("chat", cursor(4))
    // SAFETY: See above.
    await keeper.generate(context("chat") as never)
    expect(next.startSession.mock.calls[0]![0].resumeCursor).toBeUndefined()
  })
})

describe("startCodexHomeRetention", () => {
  const source = (policy: Partial<NormalizedRetention> = { maxRecords: 1 }): CodexHomeRetentionSource => ({
    cursors: () => [],
    invalidate: vi.fn(),
    policy: { ...noLimits, ...policy },
  })

  it("skips temporary and implicit homes, and warns once for the implicit home", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await rollout(1, 20 * day)
    const old = await rollout(2, 30 * day)
    expect(await startCodexHomeRetention({ home, kind: "temporary", launch: false, source: source() })).toBeUndefined()
    expect(await startCodexHomeRetention({ home: undefined, kind: "implicit", launch: false, source: source() })).toBeUndefined()
    expect(await startCodexHomeRetention({ home: undefined, kind: "implicit", launch: false, source: source() })).toBeUndefined()
    await codexHomeRetentionIdle()
    expect(await exists(old)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("does not prune the implicit Codex home ~/.codex")
  })

  it("warns once when a launched Codex home is not reachable in this process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const missing = join(root, "elsewhere")
    expect(await startCodexHomeRetention({ home: missing, kind: "configured", launch: true, source: source() })).toBeUndefined()
    expect(await startCodexHomeRetention({ home: missing, kind: "configured", launch: true, source: source() })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain("mount the home at the same path in the app container")
  })

  it("does not remove a thread that an invocation holds active", async () => {
    const active = await rollout(1, 30 * day)
    await rollout(2, day)
    const activity = await startCodexHomeRetention({ home, kind: "profile", launch: false, source: source({ maxAgeMs: 14 * day }), threadId: nativeId(1) })
    await codexHomeRetentionIdle(home)
    expect(await exists(active)).toBe(true)
    activity?.release()

    vi.setSystemTime(start + 11 * minute)
    await startCodexHomeRetention({ home, kind: "profile", launch: false, source: source({ maxAgeMs: 14 * day }) })
    await codexHomeRetentionIdle(home)
    expect(await exists(active)).toBe(false)
  })
})
