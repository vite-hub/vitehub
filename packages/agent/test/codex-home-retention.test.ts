import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { inventoryCodexHome, planCodexHomeRetention, pruneCodexHome } from "../src/internal/codex-home-retention.ts"

import type { CodexHomeInventory } from "../src/internal/codex-home-retention.ts"
import type { NormalizedRetention } from "../src/internal/retention-policy.ts"

const day = 86_400_000
const minute = 60_000
const now = Date.parse("2026-10-19T12:00:00.000Z")
const noLimits: NormalizedRetention = { maxAgeMs: false, maxRecords: false, maxSize: false }

let root: string
let home: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-codex-home-"))
  home = join(root, "codex")
  await mkdir(home)
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

function threadId(index: number): string {
  return `01a15300-0000-7000-8000-${String(index).padStart(12, "0")}`
}

async function touch(path: string, ageMs: number): Promise<void> {
  const time = new Date(now - ageMs)
  await utimes(path, time, time)
}

/** Writes a rollout like Codex: `sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, with a session_meta first line. */
async function rollout(id: string, ageMs: number, options: { bytes?: number, forkedFrom?: string } = {}): Promise<string> {
  const created = new Date(now - ageMs)
  const iso = created.toISOString()
  const path = join(home, "sessions", iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), `rollout-${iso.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  const meta = JSON.stringify({ payload: { id, ...(options.forkedFrom ? { forked_from_id: options.forkedFrom } : {}) }, type: "session_meta" })
  await writeFile(path, `${meta}\n${"x".repeat(Math.max(0, (options.bytes ?? 1024) - meta.length - 1))}`)
  await touch(path, ageMs)
  return path
}

function open(name: string): DatabaseSync {
  const db = new DatabaseSync(join(home, name))
  db.exec("PRAGMA auto_vacuum = 2; PRAGMA journal_mode = WAL;")
  return db
}

/** Codex databases with the columns retention reads. */
function createDatabases(options: { stateSchema?: "known" | "unknown" } = {}): void {
  const logs = open("logs_2.sqlite")
  logs.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'INFO', target TEXT NOT NULL DEFAULT '', feedback_log_body TEXT, thread_id TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);`)
  logs.close()
  const history = open("thread_history_1.sqlite")
  history.exec(`CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', PRIMARY KEY (thread_id, turn_id, item_id));
    CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (thread_id, turn_id));
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);`)
  history.close()
  const state = open("state_5.sqlite")
  state.exec(options.stateSchema === "unknown"
    ? "CREATE TABLE threads (id TEXT PRIMARY KEY, path TEXT NOT NULL);"
    : `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (thread_id, position));`)
  state.close()
}

function addThread(id: string, path: string, itemBytes = 200): void {
  const history = new DatabaseSync(join(home, "thread_history_1.sqlite"))
  const insert = history.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json) VALUES (?, 't', ?, ?, 0, ?)")
  for (let index = 0; index < 4; index += 1) insert.run(id, `item-${index}`, index, "y".repeat(itemBytes))
  history.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, 't', 0, 'completed')").run(id)
  history.prepare("INSERT INTO thread_history_projection_state VALUES (?, 0, 0)").run(id)
  history.close()
  const state = new DatabaseSync(join(home, "state_5.sqlite"))
  state.prepare("INSERT INTO threads VALUES (?, ?, 0, 0)").run(id, path)
  state.prepare("INSERT INTO thread_dynamic_tools VALUES (?, 0, 'tool')").run(id)
  state.close()
}

function addLogs(ageMs: number, rows: number, estimatedBytes = 100): void {
  const logs = new DatabaseSync(join(home, "logs_2.sqlite"))
  const insert = logs.prepare("INSERT INTO logs (ts, feedback_log_body, estimated_bytes) VALUES (?, ?, ?)")
  const ts = Math.floor((now - ageMs) / 1000)
  for (let index = 0; index < rows; index += 1) insert.run(ts, "z".repeat(estimatedBytes), estimatedBytes)
  logs.close()
}

function count(database: string, sql: string, ...params: string[]): number {
  const db = new DatabaseSync(join(home, database), { readOnly: true })
  const row = db.prepare(sql).get(...params)
  db.close()
  return Number(row?.count)
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

const prune = (policy: Partial<NormalizedRetention>, options: Partial<Parameters<typeof pruneCodexHome>[0]> = {}) =>
  pruneCodexHome({ home, now: () => now, policy: { ...noLimits, ...policy }, ...options })

describe("Codex home retention", () => {
  it("removes sessions, log rows, and shell snapshots older than maxAge with their thread rows", async () => {
    createDatabases()
    const old = await rollout(threadId(1), 20 * day)
    const recent = await rollout(threadId(2), 2 * day)
    addThread(threadId(1), old)
    addThread(threadId(2), recent)
    addLogs(20 * day, 50)
    addLogs(1 * day, 10)
    await mkdir(join(home, "shell_snapshots"))
    await mkdir(join(home, "thread-writer-locks"))
    const snapshot = join(home, "shell_snapshots", `${threadId(1)}.1792159926221859621.sh`)
    const writerLock = join(home, "thread-writer-locks", `${threadId(1)}.lock`)
    await writeFile(snapshot, "export A=1")
    await writeFile(writerLock, "")
    await touch(snapshot, 20 * day)
    await touch(writerLock, 20 * day)

    const report = await prune({ maxAgeMs: 14 * day })

    expect(report.removed).toMatchObject({ logRows: 50, sessions: 1, snapshots: 1 })
    expect(report.removed.threadRows).toBeGreaterThan(0)
    expect(await exists(old)).toBe(false)
    expect(await exists(dirname(old))).toBe(false)
    expect(await exists(recent)).toBe(true)
    expect(await exists(snapshot)).toBe(false)
    expect(await exists(writerLock)).toBe(false)
    expect(count("logs_2.sqlite", "SELECT COUNT(*) AS count FROM logs")).toBe(10)
    expect(count("state_5.sqlite", "SELECT COUNT(*) AS count FROM threads WHERE id = ?", threadId(1))).toBe(0)
    expect(count("state_5.sqlite", "SELECT COUNT(*) AS count FROM thread_dynamic_tools WHERE thread_id = ?", threadId(1))).toBe(0)
    expect(count("thread_history_1.sqlite", "SELECT COUNT(*) AS count FROM thread_items WHERE thread_id = ?", threadId(1))).toBe(0)
    expect(count("thread_history_1.sqlite", "SELECT COUNT(*) AS count FROM thread_items WHERE thread_id = ?", threadId(2))).toBe(4)
    expect(report.after.records).toBe(1)
  })

  it("keeps the newest maxRecords sessions", async () => {
    const paths = []
    for (let index = 1; index <= 5; index += 1) paths.push(await rollout(threadId(index), (10 - index) * day))

    const report = await prune({ maxRecords: 2 })

    expect(report.removed.sessions).toBe(3)
    expect(await Promise.all(paths.map(exists))).toEqual([false, false, false, true, true])
  })

  it("removes the oldest data until the home fits maxSize", async () => {
    const paths = []
    for (let index = 1; index <= 5; index += 1) paths.push(await rollout(threadId(index), (10 - index) * day, { bytes: 10_000 }))

    const report = await prune({ maxSize: { bytes: 25_000 } })

    expect(report.budgetBytes).toBe(25_000)
    expect(report.before.bytes).toBe(50_000)
    expect(report.after.bytes).toBe(20_000)
    expect(report.overBudget).toBe(false)
    expect(await Promise.all(paths.map(exists))).toEqual([false, false, false, true, true])
  })

  it("applies every limit together", async () => {
    const paths = []
    for (let index = 1; index <= 6; index += 1) paths.push(await rollout(threadId(index), (21 - 3 * index) * day, { bytes: 10_000 }))

    // maxAge removes the 18 and 15 day old sessions, maxRecords one more, and maxSize one more.
    const report = await prune({ maxAgeMs: 14 * day, maxRecords: 3, maxSize: { bytes: 25_000 } })

    expect(report.removed.sessions).toBe(4)
    expect(await Promise.all(paths.map(exists))).toEqual([false, false, false, false, true, true])
  })

  it("removes referenced sessions last and reports them for invalidation", async () => {
    const referenced = await rollout(threadId(1), 9 * day)
    const second = await rollout(threadId(2), 8 * day)
    const third = await rollout(threadId(3), 7 * day)
    const invalidated: string[] = []

    const kept = await prune({ maxRecords: 1 }, { referenced: [threadId(1)] })

    expect(kept.removed.sessions).toBe(2)
    expect(kept.protected.referenced).toBe(1)
    expect(await exists(referenced)).toBe(true)
    expect([await exists(second), await exists(third)]).toEqual([false, false])

    await rollout(threadId(4), 6 * day)
    const removed = await prune({ maxRecords: 1 }, { onReferencedRemoved: ids => invalidated.push(...ids), referenced: [threadId(4)] })
    expect(removed.removed.sessions).toBe(1)
    expect(await exists(referenced)).toBe(false)
    expect(invalidated).toEqual([])

    await rollout(threadId(5), 5 * day)
    await prune({ maxSize: { bytes: 1 } }, { onReferencedRemoved: ids => invalidated.push(...ids), referenced: [threadId(4), threadId(5)] })
    expect(invalidated.sort()).toEqual([threadId(4), threadId(5)])
  })

  it("protects sessions in a provider session store and their fork parents", async () => {
    const parent = await rollout(threadId(1), 9 * day)
    const child = await rollout(threadId(2), 8 * day, { forkedFrom: threadId(1) })
    const other = await rollout(threadId(3), 7 * day)
    const store = new DatabaseSync(join(root, "sessions.sqlite"))
    store.exec("CREATE TABLE t3_provider_runtime_sessions (thread_id TEXT PRIMARY KEY, resume_cursor_json TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    const cursor = { __vitehubProviderSessionCursor: "ready", value: { providerThread: { nativeThreadRef: { nativeId: threadId(2) } } } }
    store.prepare("INSERT INTO t3_provider_runtime_sessions VALUES ('chat', ?, 0)").run(JSON.stringify(cursor))
    store.close()

    const report = await prune({ maxRecords: 2 }, { sessionStorePaths: [join(root, "sessions.sqlite"), join(root, "missing.sqlite")] })

    expect(report.removed.sessions).toBe(1)
    expect(report.protected.referenced).toBe(2)
    expect([await exists(parent), await exists(child), await exists(other)]).toEqual([true, true, false])
  })

  it("never removes active sessions or files changed in the last 10 minutes", async () => {
    const active = await rollout(threadId(1), 30 * day)
    const recent = await rollout(threadId(2), 5 * minute)
    await mkdir(join(home, ".tmp"))
    const freshTmp = join(home, ".tmp", "git-fresh")
    const oldTmp = join(home, ".tmp", "git-old")
    await mkdir(freshTmp)
    await mkdir(oldTmp)
    await writeFile(join(oldTmp, "HEAD"), "ref")
    await touch(freshTmp, 2 * 3_600_000)
    await touch(oldTmp, 2 * day)

    const report = await prune({ maxAgeMs: day, maxRecords: 1, maxSize: { bytes: 1 } }, { isActive: id => id === threadId(1) })

    expect(await exists(active)).toBe(true)
    expect(await exists(recent)).toBe(true)
    expect(await exists(freshTmp)).toBe(true)
    expect(await exists(oldTmp)).toBe(false)
    expect(report.removed.tmpEntries).toBe(1)
    expect(report.protected.active).toBe(2)
    expect(report.overBudget).toBe(true)
  })

  it("shrinks a database with incremental_vacuum after it removes thread rows", async () => {
    createDatabases()
    const old = await rollout(threadId(1), 30 * day)
    addThread(threadId(1), old, 200_000)
    const historyPath = join(home, "thread_history_1.sqlite")
    const sizeBefore = (await stat(historyPath)).size

    const report = await prune({ maxAgeMs: 14 * day })

    expect(report.removed.sessions).toBe(1)
    expect(count("thread_history_1.sqlite", "SELECT freelist_count AS count FROM pragma_freelist_count()")).toBe(0)
    expect((await stat(historyPath)).size).toBeLessThan(sizeBefore / 2)
    expect(report.after.bytes).toBeLessThan(report.before.bytes)
  })

  it("does not follow or remove symbolic links", async () => {
    const outside = join(root, "outside")
    await mkdir(outside)
    const target = join(outside, `rollout-2026-01-01T00-00-00-${threadId(9)}.jsonl`)
    await writeFile(target, "{}\n")
    await mkdir(join(home, "sessions", "2026", "01", "01"), { recursive: true })
    const link = join(home, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${threadId(9)}.jsonl`)
    await symlink(target, link)
    await mkdir(join(home, ".tmp"))
    await symlink(outside, join(home, ".tmp", "git-link"))

    const inventory = await inventoryCodexHome(home)
    const report = await prune({ maxAgeMs: 1, maxRecords: 1 })

    expect(inventory.rollouts).toEqual([])
    expect(inventory.tmpEntries).toEqual([])
    expect(report.removed.sessions).toBe(0)
    expect(await exists(target)).toBe(true)
    expect(await readdir(join(home, ".tmp"))).toEqual(["git-link"])
  })

  it("leaves a database with an unknown schema unchanged and keeps the sessions it indexes", async () => {
    createDatabases({ stateSchema: "unknown" })
    const old = await rollout(threadId(1), 30 * day)
    addLogs(30 * day, 5)

    const report = await prune({ maxAgeMs: 14 * day })

    expect(report.skipped).toContain("state_5.sqlite has an unknown schema (no threads.rollout_path). Retention leaves it unchanged.")
    expect(await exists(old)).toBe(true)
    expect(report.removed.sessions).toBe(0)
    expect(report.removed.logRows).toBe(5)
  })

  it("changes nothing in a dry run", async () => {
    createDatabases()
    const old = await rollout(threadId(1), 30 * day)
    addThread(threadId(1), old)
    addLogs(30 * day, 7)

    const report = await prune({ maxAgeMs: 14 * day }, { dryRun: true })

    expect(report).toMatchObject({ dryRun: true, removed: { logRows: 7, sessions: 1 } })
    expect(report.after.records).toBe(0)
    expect(await exists(old)).toBe(true)
    expect(await exists(join(home, ".vitehub-retention.lock"))).toBe(false)
    expect(count("logs_2.sqlite", "SELECT COUNT(*) AS count FROM logs")).toBe(7)
    expect(count("state_5.sqlite", "SELECT COUNT(*) AS count FROM threads")).toBe(1)
  })

  it("stops a step when Codex holds the write lock, and the next run continues", async () => {
    createDatabases()
    const old = await rollout(threadId(1), 30 * day)
    addThread(threadId(1), old)
    const writer = new DatabaseSync(join(home, "state_5.sqlite"))
    writer.exec("BEGIN IMMEDIATE")
    let report
    try {
      report = await prune({ maxAgeMs: 14 * day })
    }
    finally {
      writer.exec("ROLLBACK")
      writer.close()
    }

    expect(report.skipped).toContain("state_5.sqlite: busy, the next run continues.")
    expect(await exists(old)).toBe(true)
    expect(count("state_5.sqlite", "SELECT COUNT(*) AS count FROM threads")).toBe(1)

    const next = await prune({ maxAgeMs: 14 * day })
    expect(next.removed.sessions).toBe(1)
    expect(await exists(old)).toBe(false)
  })

  it("skips a run while another process holds the retention lock", async () => {
    await rollout(threadId(1), 30 * day)
    await mkdir(join(home, ".vitehub-retention.lock"))

    const report = await prune({ maxAgeMs: day })

    expect(report.skipped).toEqual(["Another process holds the retention lock for this Codex home."])
    expect(report.removed.sessions).toBe(0)
  })
})

describe("planCodexHomeRetention", () => {
  const rolloutEntry = (index: number, ageMs: number, bytes = 100) => ({ bytes, mtimeMs: now - ageMs, path: `/home/sessions/${index}.jsonl`, threadId: threadId(index) })
  const inventory = (overrides: Partial<CodexHomeInventory>): CodexHomeInventory => ({
    databases: [],
    diskBytes: 0,
    home: "/home",
    logBuckets: [],
    otherBytes: 0,
    rollouts: [],
    skipped: [],
    snapshots: [],
    tmpEntries: [],
    writerLocks: [],
    ...overrides,
  })
  const context = { active: new Set<string>(), limits: { maxAgeMs: false as const, maxRecords: false as const }, now, referenced: new Set<string>() }

  it("removes old .tmp entries first and keeps entries younger than 24 hours", () => {
    const plan = planCodexHomeRetention(inventory({
      tmpEntries: [{ bytes: 10, mtimeMs: now - 2 * day, path: "/home/.tmp/old" }, { bytes: 10, mtimeMs: now - 3_600_000, path: "/home/.tmp/new" }],
    }), context)
    expect(plan.tmpEntries).toEqual(["/home/.tmp/old"])
  })

  it("orders the size queue by age across rollouts and hourly log buckets, with referenced sessions last", () => {
    const logs = { diskBytes: 300, incremental: true, kind: "logs" as const, liveBytes: 300, name: "logs_2.sqlite", path: "/home/logs_2.sqlite", walBytes: 0 }
    const plan = planCodexHomeRetention(inventory({
      databases: [logs],
      logBuckets: [
        { bytes: 100, database: logs.path, endMs: now - 5 * day, rows: 10 },
        { bytes: 100, database: logs.path, endMs: now - 3 * day, rows: 10 },
        { bytes: 100, database: logs.path, endMs: now - 1 * day, rows: 10 },
      ],
      rollouts: [rolloutEntry(1, 6 * day), rolloutEntry(2, 4 * day), rolloutEntry(3, 2 * day)],
    }), { ...context, budgetBytes: 150, referenced: new Set([threadId(1)]) })

    expect(plan.sessions.map(session => session.threadId)).toEqual([threadId(2), threadId(3)])
    expect(plan.logs).toEqual([{ beforeSeconds: Math.floor((now - day) / 1000), database: logs.path, rows: 30 }])
    expect(plan.projectedBytes).toBe(100)
    expect(plan.protected.referenced).toBe(1)

    const tighter = planCodexHomeRetention(inventory({
      databases: [logs],
      logBuckets: [{ bytes: 300, database: logs.path, endMs: now - 5 * day, rows: 30 }],
      rollouts: [rolloutEntry(1, 6 * day), rolloutEntry(2, 4 * day)],
    }), { ...context, budgetBytes: 50, referenced: new Set([threadId(1)]) })
    expect(tighter.sessions).toEqual([
      expect.objectContaining({ referenced: false, threadId: threadId(2) }),
      expect.objectContaining({ reason: "size", referenced: true, threadId: threadId(1) }),
    ])
  })

  it("keeps log rows of the last 10 minutes and counts a share of thread history in each session", () => {
    const history = { diskBytes: 1_000, incremental: true, kind: "thread_history" as const, liveBytes: 1_000, name: "thread_history_1.sqlite", path: "/home/thread_history_1.sqlite", walBytes: 0 }
    const logs = { diskBytes: 100, incremental: true, kind: "logs" as const, liveBytes: 100, name: "logs_2.sqlite", path: "/home/logs_2.sqlite", walBytes: 0 }
    const plan = planCodexHomeRetention(inventory({
      databases: [history, logs],
      logBuckets: [{ bytes: 100, database: logs.path, endMs: now + 3_600_000, rows: 5 }],
      rollouts: [rolloutEntry(1, 2 * day, 300), rolloutEntry(2, day, 100)],
    }), { ...context, budgetBytes: 900 })

    // Session 1 is 300 bytes plus 3/4 of the 1,000 history bytes.
    expect(plan.sessions.map(session => session.threadId)).toEqual([threadId(1)])
    expect(plan.projectedBytes).toBe(1_500 - 1_050)
    expect(plan.logs).toEqual([])
  })
})
