import { access, constants, lstat, open, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { lock } from "proper-lockfile"

import { providerNativeThreadId } from "./provider-session-cursor.ts"
import { retentionBudgetBytes } from "./retention-volume.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

import type { DatabaseSync } from "node:sqlite"
import type { NormalizedRetention, RetentionSizeLimit } from "./retention-policy.ts"

/*
 * Codex writes rollouts, SQLite logs, thread history, shell snapshots, and temporary Git directories
 * into its home, and it never removes them. This module prunes a Codex home with a retention policy.
 * Only node:sqlite opens the Codex databases in this process, and every write transaction is short,
 * because Codex can write the same files at the same time.
 */

const minute = 60_000
const hour = 60 * minute
/** Files changed in this window can belong to a running Codex thread. Retention never removes them. */
export const codexHomeRetentionGraceMs = 10 * minute
/** Retention runs on the first Codex invocation for a home, then at most once in this interval. */
export const codexHomeRetentionIntervalMs = 10 * minute
const tmpEntryMaxAgeMs = 24 * hour
const logDeleteBatchRows = 2_000
const threadDeleteBatch = 50
const incrementalVacuumPages = 2_048
const maxSizePasses = 3
const sessionMetaMaxBytes = 1024 * 1024
const busyTimeoutMs = 2_000
const lockFileName = ".vitehub-retention.lock"

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const rolloutPattern = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuid})\\.jsonl$`, "i")
const snapshotPattern = new RegExp(`^(${uuid})\\.\\d+\\.sh$`, "i")
const writerLockPattern = new RegExp(`^(${uuid})\\.lock$`, "i")
const databasePattern = /^(logs|state|thread_history)_\d+\.sqlite$/
const datedDirectoryPattern = /^\d{2,4}$/

type CodexDatabaseKind = "logs" | "state" | "thread_history"

interface CodexHomeEntry {
  bytes: number
  mtimeMs: number
  path: string
}

interface CodexThreadEntry extends CodexHomeEntry {
  threadId: string
}

interface CodexDatabase {
  /** Physical size of the main file, the WAL, and the shared-memory file. */
  diskBytes: number
  kind: CodexDatabaseKind
  /** Bytes in pages that hold data: (page_count - freelist_count) * page_size. */
  liveBytes: number
  name: string
  path: string
  /** Set when retention must not change this database, for example an unknown schema. */
  unusable?: string
  walBytes: number
  incremental: boolean
}

interface CodexLogBucket {
  /** Live database bytes that this bucket's rows hold, estimated from `estimated_bytes`. */
  bytes: number
  database: string
  /** End of the hour, in milliseconds since the epoch. */
  endMs: number
  rows: number
}

/** What a Codex home holds. Paths are absolute. Symbolic links are never followed or listed. */
export interface CodexHomeInventory {
  databases: CodexDatabase[]
  /** Bytes on disk of every regular file, with database files at their physical size. */
  diskBytes: number
  home: string
  logBuckets: CodexLogBucket[]
  /** Bytes of regular files that retention never removes, such as config, auth, skills, and unknown files. */
  otherBytes: number
  rollouts: CodexThreadEntry[]
  snapshots: CodexThreadEntry[]
  skipped: string[]
  tmpEntries: CodexHomeEntry[]
  writerLocks: CodexThreadEntry[]
}

export interface CodexHomeRetentionPlanContext {
  /** Native thread IDs that run in this process now. */
  active: ReadonlySet<string>
  budgetBytes?: number
  limits: Pick<NormalizedRetention, "maxAgeMs" | "maxRecords">
  now: number
  /** Native thread IDs that a stored resume cursor still needs. They go last. */
  referenced: ReadonlySet<string>
}

export interface CodexHomeRetentionPlannedSession {
  path: string
  reason: "age" | "count" | "size"
  referenced: boolean
  threadId: string
}

export interface CodexHomeRetentionPlan {
  /** Delete log rows with `ts` (seconds) before `beforeSeconds` in each database. */
  logs: { beforeSeconds: number, database: string, rows: number }[]
  overBudget: boolean
  projectedBytes: number
  protected: { active: number, referenced: number }
  sessions: CodexHomeRetentionPlannedSession[]
  /** Shell snapshots older than maxAge whose thread retention keeps. */
  snapshots: string[]
  tmpEntries: string[]
}

export interface CodexHomeRetentionMeasure {
  /** Bytes that the policy counts: regular files, SQLite live bytes, and WAL bytes. */
  bytes: number
  /** Bytes on disk of every regular file. */
  diskBytes: number
  /** Codex sessions (rollout files). */
  records: number
}

export interface CodexHomeRetentionReport {
  after: CodexHomeRetentionMeasure
  before: CodexHomeRetentionMeasure
  budgetBytes?: number
  dryRun: boolean
  home: string
  overBudget: boolean
  policy: { maxAge: false | number, maxRecords: false | number, maxSize: false | number | string }
  protected: { active: number, referenced: number }
  removed: { logRows: number, sessions: number, snapshots: number, threadRows: number, tmpEntries: number }
  skipped: string[]
}

export interface PruneCodexHomeOptions {
  dryRun?: boolean
  home: string
  /** Called during apply. A thread that it reports is never removed. */
  isActive?: (threadId: string) => boolean
  now?: () => number
  /** Called with the referenced native thread IDs that retention removed, so their cursors can be dropped. */
  onReferencedRemoved?: (threadIds: ReadonlySet<string>) => void
  /** One or more policies. The strictest value of each limit applies. */
  policy: NormalizedRetention | readonly NormalizedRetention[]
  /** Native thread IDs that resume cursors in this process reference. */
  referenced?: Iterable<string>
  /** SQLite provider session stores (`driver.sessionStorePath`). Their cursors protect sessions like `referenced`. */
  sessionStorePaths?: readonly string[]
}

type Sqlite = typeof import("node:sqlite")

let sqliteModule: Promise<Sqlite> | undefined

function loadSqlite(): Promise<Sqlite> {
  return sqliteModule ??= import("node:sqlite")
}

function errorCode(error: unknown): string | undefined {
  return isRuntimeRecord(error) && hasRuntimeType(error.code, "string") ? error.code : undefined
}

function isSqliteBusy(error: unknown): boolean {
  if (!isRuntimeRecord(error)) return false
  const code = hasRuntimeType(error.errcode, "number") ? error.errcode & 0xFF : undefined
  return code === 5 || code === 6
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get()
  const value = row?.[name]
  return hasRuntimeType(value, "number") ? value : hasRuntimeType(value, "bigint") ? Number(value) : 0
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(row => String(row.name)))
}

function tableNames(db: DatabaseSync): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name))
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

async function fileBytes(path: string): Promise<number> {
  const entry = await lstat(path).catch(() => undefined)
  return entry?.isFile() ? entry.size : 0
}

/** Sums regular files below `path` without following symbolic links. */
async function treeBytes(path: string): Promise<number> {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry || entry.isSymbolicLink()) return 0
  if (entry.isFile()) return entry.size
  if (!entry.isDirectory()) return 0
  const children = await readdir(path).catch(() => [])
  let total = 0
  for (const child of children) total += await treeBytes(join(path, child))
  return total
}

/** Schema that retention needs in each Codex database. A database without it is left unchanged. */
function schemaProblem(db: DatabaseSync, kind: CodexDatabaseKind): string | undefined {
  const need = (table: string, columns: string[]) => {
    const present = tableColumns(db, table)
    const missing = columns.filter(column => !present.has(column))
    return missing.length ? `${table}.${missing.join(`, ${table}.`)}` : undefined
  }
  if (kind === "logs") return need("logs", ["id", "ts"])
  if (kind === "state") return need("threads", ["id", "rollout_path"])
  return need("thread_items", ["thread_id"])
}

async function inventoryDatabase(sqlite: Sqlite, path: string, kind: CodexDatabaseKind, buckets: CodexLogBucket[]): Promise<CodexDatabase> {
  const name = basename(path)
  const walBytes = await fileBytes(`${path}-wal`)
  const diskBytes = await fileBytes(path) + walBytes + await fileBytes(`${path}-shm`)
  const database: CodexDatabase = { diskBytes, incremental: false, kind, liveBytes: await fileBytes(path), name, path, walBytes }
  let db: DatabaseSync | undefined
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    const pageSize = pragmaNumber(db, "page_size")
    database.liveBytes = (pragmaNumber(db, "page_count") - pragmaNumber(db, "freelist_count")) * pageSize
    database.incremental = pragmaNumber(db, "auto_vacuum") === 2
    const problem = schemaProblem(db, kind)
    if (problem) {
      database.unusable = `${name} has an unknown schema (no ${problem}). Retention leaves it unchanged.`
      return database
    }
    if (kind === "logs") {
      const weighted = tableColumns(db, "logs").has("estimated_bytes")
      const rows = db.prepare(`SELECT ts / 3600 AS hour, COUNT(*) AS rows, ${weighted ? "SUM(estimated_bytes)" : "0"} AS weight FROM logs GROUP BY ts / 3600 ORDER BY hour`).all()
      const parsed = rows.map(row => ({ hour: Number(row.hour), rows: Number(row.rows), weight: Number(row.weight) }))
      const totalWeight = parsed.reduce((sum, row) => sum + row.weight, 0)
      const totalRows = parsed.reduce((sum, row) => sum + row.rows, 0)
      // Old Codex releases left estimated_bytes at 0. Then each row counts the same.
      for (const row of parsed) {
        const share = totalWeight > 0 ? row.weight / totalWeight : totalRows > 0 ? row.rows / totalRows : 0
        buckets.push({ bytes: Math.round(database.liveBytes * share), database: path, endMs: (row.hour + 1) * hour, rows: row.rows })
      }
    }
  }
  catch (error) {
    database.unusable = `${name} could not be read: ${errorMessage(error)}`
  }
  finally {
    db?.close()
  }
  return database
}

/** Lists what a Codex home holds. It reads only, and it never follows a symbolic link. */
export async function inventoryCodexHome(home: string): Promise<CodexHomeInventory> {
  const inventory: CodexHomeInventory = {
    databases: [],
    diskBytes: 0,
    home,
    logBuckets: [],
    otherBytes: 0,
    rollouts: [],
    snapshots: [],
    skipped: [],
    tmpEntries: [],
    writerLocks: [],
  }
  const rootEntry = await lstat(home).catch(() => undefined)
  if (!rootEntry?.isDirectory()) {
    inventory.skipped.push(`${home} is not a directory.`)
    return inventory
  }
  const databaseFiles = new Set<string>()
  const walk = async (directory: string, relativeParts: string[]): Promise<void> => {
    const names = await readdir(directory).catch((error: unknown) => {
      inventory.skipped.push(`${directory} could not be read: ${errorCode(error) ?? errorMessage(error)}.`)
      return []
    })
    for (const name of names) {
      const path = join(directory, name)
      const entry = await lstat(path).catch(() => undefined)
      if (!entry || entry.isSymbolicLink()) continue
      const top = relativeParts[0]
      if (entry.isDirectory()) {
        if (relativeParts.length === 0 && name === ".tmp") {
          for (const child of await readdir(path).catch(() => [])) {
            const childPath = join(path, child)
            const childEntry = await lstat(childPath).catch(() => undefined)
            if (!childEntry || childEntry.isSymbolicLink()) continue
            const bytes = await treeBytes(childPath)
            inventory.diskBytes += bytes
            inventory.tmpEntries.push({ bytes, mtimeMs: childEntry.mtimeMs, path: childPath })
          }
          continue
        }
        if (relativeParts.length === 0 && name === lockFileName) continue
        await walk(path, [...relativeParts, name])
        continue
      }
      if (!entry.isFile()) continue
      inventory.diskBytes += entry.size
      if (relativeParts.length === 0 && (databasePattern.test(name) || databasePattern.test(name.replace(/-(?:wal|shm)$/, "")))) {
        if (databasePattern.test(name)) databaseFiles.add(path)
        continue
      }
      const rollout = (top === "sessions" || top === "archived_sessions") ? rolloutPattern.exec(name) : null
      if (rollout) {
        inventory.rollouts.push({ bytes: entry.size, mtimeMs: entry.mtimeMs, path, threadId: rollout[1]!.toLowerCase() })
        continue
      }
      const snapshot = relativeParts.length === 1 && top === "shell_snapshots" ? snapshotPattern.exec(name) : null
      if (snapshot) {
        inventory.snapshots.push({ bytes: entry.size, mtimeMs: entry.mtimeMs, path, threadId: snapshot[1]!.toLowerCase() })
        continue
      }
      const writerLock = relativeParts.length === 1 && top === "thread-writer-locks" ? writerLockPattern.exec(name) : null
      if (writerLock) {
        inventory.writerLocks.push({ bytes: entry.size, mtimeMs: entry.mtimeMs, path, threadId: writerLock[1]!.toLowerCase() })
        continue
      }
      inventory.otherBytes += entry.size
    }
  }
  await walk(home, [])
  const sqlite = databaseFiles.size ? await loadSqlite() : undefined
  for (const path of [...databaseFiles].sort()) {
    const kind = /^(logs|state|thread_history)_/.exec(basename(path))![1] as CodexDatabaseKind
    const database = await inventoryDatabase(sqlite!, path, kind, inventory.logBuckets)
    if (database.unusable) inventory.skipped.push(database.unusable)
    inventory.databases.push(database)
  }
  inventory.rollouts.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))
  inventory.logBuckets.sort((left, right) => left.endMs - right.endMs)
  return inventory
}

/** Measures a Codex home the way the policy counts it. */
export function measureCodexHome(inventory: CodexHomeInventory): CodexHomeRetentionMeasure {
  const sum = (entries: readonly { bytes: number }[]) => entries.reduce((total, entry) => total + entry.bytes, 0)
  const databaseBytes = inventory.databases.reduce((total, database) => total + database.liveBytes + database.walBytes, 0)
  return {
    bytes: sum(inventory.rollouts) + sum(inventory.tmpEntries) + sum(inventory.snapshots) + sum(inventory.writerLocks) + databaseBytes + inventory.otherBytes,
    diskBytes: inventory.diskBytes,
    records: inventory.rollouts.length,
  }
}

/**
 * Decides what retention removes, without side effects. The order is: `.tmp` entries older than 24 hours,
 * then maxAge (rollouts, log rows, shell snapshots), then maxRecords (keep the newest rollouts), then maxSize
 * (one oldest-first queue of rollouts and hourly log buckets). Active threads and files changed in the last
 * 10 minutes are never removed. Referenced threads go last: only when a limit still fails without them.
 */
export function planCodexHomeRetention(inventory: CodexHomeInventory, context: CodexHomeRetentionPlanContext): CodexHomeRetentionPlan {
  const { now } = context
  const plan: CodexHomeRetentionPlan = { logs: [], overBudget: false, projectedBytes: measureCodexHome(inventory).bytes, protected: { active: 0, referenced: 0 }, sessions: [], snapshots: [], tmpEntries: [] }
  const recent = (mtimeMs: number) => now - mtimeMs < codexHomeRetentionGraceMs
  const isProtected = (rollout: CodexThreadEntry) => context.active.has(rollout.threadId) || recent(rollout.mtimeMs)
  const usable = (kind: CodexDatabaseKind) => inventory.databases.filter(database => database.kind === kind && !database.unusable)
  const historyBytes = usable("thread_history").reduce((total, database) => total + database.liveBytes, 0)
  const rolloutBytes = inventory.rollouts.reduce((total, rollout) => total + rollout.bytes, 0)
  const threadFiles = new Map<string, number>()
  for (const entry of [...inventory.snapshots, ...inventory.writerLocks]) threadFiles.set(entry.threadId, (threadFiles.get(entry.threadId) ?? 0) + entry.bytes)
  // A rollout unit is the file, its share of thread_history, and its snapshots and writer lock.
  const unitBytes = (rollout: CodexThreadEntry) => rollout.bytes
    + (rolloutBytes > 0 ? Math.round(historyBytes * rollout.bytes / rolloutBytes) : 0)
    + (threadFiles.get(rollout.threadId) ?? 0)

  for (const entry of inventory.tmpEntries) {
    if (now - entry.mtimeMs < tmpEntryMaxAgeMs) continue
    plan.tmpEntries.push(entry.path)
    plan.projectedBytes -= entry.bytes
  }

  const removedThreads = new Set<string>()
  const remaining = () => inventory.rollouts.filter(rollout => !removedThreads.has(rollout.threadId))
  // Unreferenced rollouts first, each group oldest first.
  const byPriority = (rollouts: CodexThreadEntry[]) => [
    ...rollouts.filter(rollout => !context.referenced.has(rollout.threadId)),
    ...rollouts.filter(rollout => context.referenced.has(rollout.threadId)),
  ]
  const removeSession = (rollout: CodexThreadEntry, reason: CodexHomeRetentionPlannedSession["reason"]) => {
    removedThreads.add(rollout.threadId)
    plan.sessions.push({ path: rollout.path, reason, referenced: context.referenced.has(rollout.threadId), threadId: rollout.threadId })
    plan.projectedBytes -= unitBytes(rollout)
  }
  const logCutoffs = new Map<string, { beforeSeconds: number, rows: number }>()
  const removedBuckets = new Set<CodexLogBucket>()
  const removeBucket = (bucket: CodexLogBucket) => {
    removedBuckets.add(bucket)
    const cutoff = logCutoffs.get(bucket.database) ?? { beforeSeconds: 0, rows: 0 }
    cutoff.beforeSeconds = Math.max(cutoff.beforeSeconds, Math.floor(bucket.endMs / 1000))
    cutoff.rows += bucket.rows
    logCutoffs.set(bucket.database, cutoff)
    plan.projectedBytes -= bucket.bytes
  }
  const logsUsable = new Set(usable("logs").map(database => database.path))
  const removableBuckets = () => inventory.logBuckets.filter(bucket => logsUsable.has(bucket.database) && !removedBuckets.has(bucket) && !recent(bucket.endMs))

  if (context.limits.maxAgeMs !== false) {
    const cutoff = now - context.limits.maxAgeMs
    for (const rollout of byPriority(remaining().filter(rollout => rollout.mtimeMs < cutoff && !isProtected(rollout)))) removeSession(rollout, "age")
    for (const bucket of removableBuckets()) {
      if (bucket.endMs <= cutoff) removeBucket(bucket)
    }
    for (const snapshot of inventory.snapshots) {
      if (snapshot.mtimeMs >= cutoff || removedThreads.has(snapshot.threadId) || context.active.has(snapshot.threadId) || recent(snapshot.mtimeMs)) continue
      plan.snapshots.push(snapshot.path)
      plan.projectedBytes -= snapshot.bytes
    }
  }

  if (context.limits.maxRecords !== false) {
    const kept = remaining()
    let excess = kept.length - context.limits.maxRecords
    for (const rollout of byPriority(kept.filter(rollout => !isProtected(rollout)))) {
      if (excess <= 0) break
      removeSession(rollout, "count")
      excess -= 1
    }
  }

  if (context.budgetBytes !== undefined && plan.projectedBytes > context.budgetBytes) {
    const queue = [
      ...remaining().filter(rollout => !isProtected(rollout) && !context.referenced.has(rollout.threadId)).map(rollout => ({ at: rollout.mtimeMs, rollout })),
      ...removableBuckets().map(bucket => ({ at: bucket.endMs, bucket })),
    ].sort((left, right) => left.at - right.at)
    for (const item of queue) {
      if (plan.projectedBytes <= context.budgetBytes) break
      if ("rollout" in item) removeSession(item.rollout, "size")
      else removeBucket(item.bucket)
    }
    for (const rollout of remaining().filter(rollout => !isProtected(rollout) && context.referenced.has(rollout.threadId))) {
      if (plan.projectedBytes <= context.budgetBytes) break
      removeSession(rollout, "size")
    }
  }

  for (const [database, cutoff] of logCutoffs) plan.logs.push({ beforeSeconds: cutoff.beforeSeconds, database, rows: cutoff.rows })
  for (const rollout of remaining()) {
    if (isProtected(rollout)) plan.protected.active += 1
    else if (context.referenced.has(rollout.threadId)) plan.protected.referenced += 1
  }
  plan.overBudget = context.budgetBytes !== undefined && plan.projectedBytes > context.budgetBytes
  return plan
}

async function readForkParent(path: string): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined)
  if (!handle) return
  try {
    const buffer = Buffer.alloc(sessionMetaMaxBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString("utf8")
    const end = text.indexOf("\n")
    if (end < 0) return
    const line: unknown = JSON.parse(text.slice(0, end))
    if (!isRuntimeRecord(line) || line.type !== "session_meta" || !isRuntimeRecord(line.payload)) return
    const parent = line.payload.forked_from_id
    return hasRuntimeType(parent, "string") ? parent.toLowerCase() : undefined
  }
  catch {
    return
  }
  finally {
    await handle.close()
  }
}

/** Adds the threads that referenced threads were forked from, because a fork can read its parent's rollout. */
async function withForkParents(inventory: CodexHomeInventory, referenced: Set<string>): Promise<Set<string>> {
  const rollouts = new Map(inventory.rollouts.map(rollout => [rollout.threadId, rollout.path]))
  let pending = [...referenced]
  while (pending.length) {
    const next: string[] = []
    for (const threadId of pending) {
      const path = rollouts.get(threadId)
      const parent = path ? await readForkParent(path) : undefined
      if (parent && !referenced.has(parent)) {
        referenced.add(parent)
        next.push(parent)
      }
    }
    pending = next
  }
  return referenced
}

/** Reads native thread IDs from a provider session store read-only. A missing file or table is empty. */
async function sessionStoreThreadIds(path: string, skipped: string[]): Promise<string[]> {
  if (!(await lstat(path).catch(() => undefined))?.isFile()) return []
  const sqlite = await loadSqlite()
  let db: DatabaseSync | undefined
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    if (!tableColumns(db, "t3_provider_runtime_sessions").has("resume_cursor_json")) return []
    const ids: string[] = []
    for (const row of db.prepare("SELECT resume_cursor_json FROM t3_provider_runtime_sessions").all()) {
      let cursor: unknown
      try {
        cursor = JSON.parse(String(row.resume_cursor_json))
      }
      catch {
        continue
      }
      const id = providerNativeThreadId(cursor)
      if (id) ids.push(id.toLowerCase())
    }
    return ids
  }
  catch (error) {
    // Without the store, retention cannot know which sessions it protects. Treat every session as referenced.
    skipped.push(`Session store ${path} could not be read, so retention removes nothing in this run: ${errorMessage(error)}`)
    throw error
  }
  finally {
    db?.close()
  }
}

interface ApplyResult {
  removed: CodexHomeRetentionReport["removed"]
  removedThreads: Set<string>
}

interface ApplyContext {
  isActive: (threadId: string) => boolean
  now: () => number
  skipped: string[]
}

async function openWritable(sqlite: Sqlite, path: string): Promise<DatabaseSync> {
  const db = new sqlite.DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  return db
}

function runInTransaction(db: DatabaseSync, work: () => number): number {
  db.exec("BEGIN IMMEDIATE")
  try {
    const changes = work()
    db.exec("COMMIT")
    return changes
  }
  catch (error) {
    try {
      db.exec("ROLLBACK")
    }
    catch {}
    throw error
  }
}

/** Removes rows of the given threads from one Codex database. Returns the IDs whose rows are gone. */
function deleteThreadRows(db: DatabaseSync, kind: "state" | "thread_history", threadIds: readonly string[]): { done: string[], rows: number } {
  const statements: { sql: string, params: number }[] = []
  for (const table of tableNames(db)) {
    const columns = tableColumns(db, table)
    if (columns.has("thread_id")) statements.push({ params: 1, sql: `DELETE FROM ${quoteIdentifier(table)} WHERE thread_id IN (SELECT value FROM json_each(?))` })
  }
  if (kind === "state") {
    const edges = tableColumns(db, "thread_spawn_edges")
    if (edges.has("parent_thread_id") && edges.has("child_thread_id")) {
      statements.push({ params: 2, sql: "DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (SELECT value FROM json_each(?)) OR child_thread_id IN (SELECT value FROM json_each(?))" })
    }
    statements.push({ params: 1, sql: "DELETE FROM threads WHERE id IN (SELECT value FROM json_each(?))" })
  }
  const done: string[] = []
  let rows = 0
  for (let index = 0; index < threadIds.length; index += threadDeleteBatch) {
    const batch = threadIds.slice(index, index + threadDeleteBatch)
    const json = JSON.stringify(batch)
    rows += runInTransaction(db, () => statements.reduce((total, statement) => {
      const result = db.prepare(statement.sql).run(...Array.from({ length: statement.params }, () => json))
      return total + Number(result.changes)
    }, 0))
    done.push(...batch)
  }
  return { done, rows }
}

function incrementalVacuum(db: DatabaseSync): void {
  if (pragmaNumber(db, "auto_vacuum") !== 2) return
  let free = pragmaNumber(db, "freelist_count")
  // Each statement is its own short write transaction, so Codex can write between the steps.
  while (free > 0) {
    db.exec(`PRAGMA incremental_vacuum(${incrementalVacuumPages})`)
    const next = pragmaNumber(db, "freelist_count")
    if (next >= free) break
    free = next
  }
}

async function removeFile(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry?.isFile()) return false
  await unlink(path)
  return true
}

async function removeEmptyDatedDirectories(directory: string): Promise<void> {
  for (const name of await readdir(directory).catch(() => [])) {
    if (!datedDirectoryPattern.test(name)) continue
    const path = join(directory, name)
    const entry = await lstat(path).catch(() => undefined)
    if (!entry?.isDirectory()) continue
    await removeEmptyDatedDirectories(path)
    await rmdir(path).catch(() => undefined)
  }
}

async function applyCodexHomeRetentionPlan(inventory: CodexHomeInventory, plan: CodexHomeRetentionPlan, context: ApplyContext): Promise<ApplyResult> {
  const removed: CodexHomeRetentionReport["removed"] = { logRows: 0, sessions: 0, snapshots: 0, threadRows: 0, tmpEntries: 0 }
  const removedThreads = new Set<string>()
  const recent = async (path: string) => {
    const entry = await lstat(path).catch(() => undefined)
    return entry !== undefined && context.now() - entry.mtimeMs < codexHomeRetentionGraceMs
  }

  for (const path of plan.tmpEntries) {
    const entry = await lstat(path).catch(() => undefined)
    if (!entry || entry.isSymbolicLink() || context.now() - entry.mtimeMs < tmpEntryMaxAgeMs) continue
    try {
      await rm(path, { force: true, recursive: true })
      removed.tmpEntries += 1
    }
    catch (error) {
      context.skipped.push(`${path} could not be removed: ${errorCode(error) ?? errorMessage(error)}.`)
      break
    }
  }

  // Check every session again: a thread can start, or its rollout can change, after the plan.
  const sessions = []
  for (const session of plan.sessions) {
    if (context.isActive(session.threadId) || await recent(session.path)) continue
    sessions.push(session)
  }
  const sqlite = inventory.databases.length ? await loadSqlite() : undefined
  // Remove database rows before the rollout. A rollout without rows is safe, because Codex can index it again.
  let rowsRemoved = new Set(sessions.map(session => session.threadId))
  for (const database of inventory.databases) {
    if (database.kind === "logs" || !sessions.length) continue
    if (database.unusable) {
      // A thread whose rows cannot be removed keeps its rollout, so the database stays consistent.
      rowsRemoved = new Set()
      continue
    }
    let db: DatabaseSync | undefined
    try {
      db = await openWritable(sqlite!, database.path)
      const result = deleteThreadRows(db, database.kind, [...rowsRemoved])
      removed.threadRows += result.rows
      rowsRemoved = new Set(result.done)
      incrementalVacuum(db)
    }
    catch (error) {
      context.skipped.push(`${database.name}: ${isSqliteBusy(error) ? "busy, the next run continues" : errorMessage(error)}.`)
      rowsRemoved = new Set()
    }
    finally {
      db?.close()
    }
  }
  for (const session of sessions) {
    if (!rowsRemoved.has(session.threadId)) continue
    try {
      if (await removeFile(session.path)) {
        removed.sessions += 1
        removedThreads.add(session.threadId)
      }
    }
    catch (error) {
      context.skipped.push(`${session.path} could not be removed: ${errorCode(error) ?? errorMessage(error)}.`)
      break
    }
  }

  const threadFiles = [...inventory.snapshots, ...inventory.writerLocks].filter(entry => removedThreads.has(entry.threadId))
  const snapshotPaths = new Set([...plan.snapshots, ...threadFiles.map(entry => entry.path)])
  const threadOfPath = new Map([...inventory.snapshots, ...inventory.writerLocks].map(entry => [entry.path, entry.threadId]))
  for (const path of snapshotPaths) {
    const threadId = threadOfPath.get(path)
    if (threadId && context.isActive(threadId)) continue
    if (!removedThreads.has(threadId ?? "") && await recent(path)) continue
    try {
      if (await removeFile(path) && inventory.snapshots.some(snapshot => snapshot.path === path)) removed.snapshots += 1
    }
    catch (error) {
      context.skipped.push(`${path} could not be removed: ${errorCode(error) ?? errorMessage(error)}.`)
      break
    }
  }

  for (const cutoff of plan.logs) {
    const database = inventory.databases.find(entry => entry.path === cutoff.database)
    if (!database || database.unusable) continue
    let db: DatabaseSync | undefined
    try {
      db = await openWritable(sqlite!, database.path)
      const statement = db.prepare("DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE ts < ? ORDER BY ts LIMIT ?)")
      while (true) {
        const changes = Number(statement.run(cutoff.beforeSeconds, logDeleteBatchRows).changes)
        removed.logRows += changes
        if (changes < logDeleteBatchRows) break
      }
      incrementalVacuum(db)
    }
    catch (error) {
      context.skipped.push(`${database.name}: ${isSqliteBusy(error) ? "busy, the next run continues" : errorMessage(error)}.`)
    }
    finally {
      db?.close()
    }
  }

  if (removedThreads.size) {
    await removeEmptyDatedDirectories(join(inventory.home, "sessions"))
    await removeEmptyDatedDirectories(join(inventory.home, "archived_sessions"))
  }
  return { removed, removedThreads }
}

interface ResolvedLimits {
  budgetBytes?: number
  limits: Pick<NormalizedRetention, "maxAgeMs" | "maxRecords">
  policy: CodexHomeRetentionReport["policy"]
}

function strictest(values: readonly (false | number)[]): false | number {
  const numbers = values.filter((value): value is number => value !== false)
  return numbers.length ? Math.min(...numbers) : false
}

function describeSize(size: RetentionSizeLimit): number | string {
  return "bytes" in size ? size.bytes : `${Number((size.fraction * 100).toFixed(4))}%`
}

async function resolveLimits(home: string, policies: readonly NormalizedRetention[]): Promise<ResolvedLimits> {
  const maxAgeMs = strictest(policies.map(policy => policy.maxAgeMs))
  const maxRecords = strictest(policies.map(policy => policy.maxRecords))
  let budgetBytes: number | undefined
  let maxSize: false | number | string = false
  for (const policy of policies) {
    if (policy.maxSize === false) continue
    const budget = await retentionBudgetBytes(policy.maxSize, join(home, lockFileName))
    if (budgetBytes === undefined || budget < budgetBytes) {
      budgetBytes = budget
      maxSize = describeSize(policy.maxSize)
    }
  }
  return { budgetBytes, limits: { maxAgeMs, maxRecords }, policy: { maxAge: maxAgeMs, maxRecords, maxSize } }
}

async function collectReferences(options: PruneCodexHomeOptions, inventory: CodexHomeInventory, skipped: string[]): Promise<Set<string> | undefined> {
  const referenced = new Set([...options.referenced ?? []].map(id => id.toLowerCase()))
  for (const path of options.sessionStorePaths ?? []) {
    try {
      for (const id of await sessionStoreThreadIds(resolve(path), skipped)) referenced.add(id)
    }
    catch {
      return undefined
    }
  }
  return await withForkParents(inventory, referenced)
}

async function acquireRetentionLock(home: string): Promise<{ compromised: () => boolean, release: () => Promise<void> } | undefined> {
  let compromised = false
  try {
    const release = await lock(home, {
      lockfilePath: join(home, lockFileName),
      onCompromised() { compromised = true },
      realpath: false,
      retries: 0,
      stale: 60_000,
      update: 10_000,
    })
    return { compromised: () => compromised, release: async () => { await release().catch(() => undefined) } }
  }
  catch (error) {
    if (errorCode(error) === "ELOCKED") return undefined
    throw error
  }
}

/**
 * Applies a retention policy to one Codex home and reports what changed. The app and
 * `vitehub agent codex-home prune` use the same function and the same lock file,
 * `<home>/.vitehub-retention.lock`. A dry run reads only.
 */
export async function pruneCodexHome(options: PruneCodexHomeOptions): Promise<CodexHomeRetentionReport> {
  const now = options.now ?? Date.now
  const home = resolve(options.home)
  const dryRun = options.dryRun === true
  const policies = Array.isArray(options.policy) ? options.policy : [options.policy as NormalizedRetention]
  const { budgetBytes, limits, policy } = await resolveLimits(home, policies)
  const skipped: string[] = []
  const report = (before: CodexHomeRetentionMeasure, after: CodexHomeRetentionMeasure, overBudget: boolean): CodexHomeRetentionReport => ({
    after,
    before,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    dryRun,
    home,
    overBudget,
    policy,
    protected: { active: 0, referenced: 0 },
    removed: { logRows: 0, sessions: 0, snapshots: 0, threadRows: 0, tmpEntries: 0 },
    skipped,
  })
  const empty = { bytes: 0, diskBytes: 0, records: 0 }
  if (!(await lstat(home).catch(() => undefined))?.isDirectory()) {
    skipped.push(`${home} is not a directory.`)
    return report(empty, empty, false)
  }
  const held = dryRun ? undefined : await acquireRetentionLock(home)
  if (!dryRun && !held) {
    skipped.push("Another process holds the retention lock for this Codex home.")
    const measure = measureCodexHome(await inventoryCodexHome(home))
    return report(measure, measure, budgetBytes !== undefined && measure.bytes > budgetBytes)
  }
  try {
    let inventory = await inventoryCodexHome(home)
    skipped.push(...inventory.skipped)
    const before = measureCodexHome(inventory)
    const referenced = await collectReferences(options, inventory, skipped)
    if (!referenced) return report(before, before, budgetBytes !== undefined && before.bytes > budgetBytes)
    const active = new Set<string>()
    const isActive = (threadId: string) => active.has(threadId) || options.isActive?.(threadId) === true
    const planContext = () => {
      active.clear()
      for (const rollout of inventory.rollouts) if (options.isActive?.(rollout.threadId)) active.add(rollout.threadId)
      return { active, budgetBytes, limits, now: now(), referenced }
    }
    let plan = planCodexHomeRetention(inventory, planContext())
    const result = report(before, { ...before, bytes: plan.projectedBytes }, plan.overBudget)
    result.protected = plan.protected
    if (dryRun) {
      result.removed = {
        logRows: plan.logs.reduce((total, cutoff) => total + cutoff.rows, 0),
        sessions: plan.sessions.length,
        snapshots: plan.snapshots.length + inventory.snapshots.filter(snapshot => plan.sessions.some(session => session.threadId === snapshot.threadId)).length,
        threadRows: 0,
        tmpEntries: plan.tmpEntries.length,
      }
      result.after = { bytes: plan.projectedBytes, diskBytes: Math.max(0, before.diskBytes - (before.bytes - plan.projectedBytes)), records: before.records - plan.sessions.length }
      return result
    }
    const removedReferenced = new Set<string>()
    // The size step uses estimates, so measure again and repeat at most three times.
    for (let pass = 0; pass < maxSizePasses; pass += 1) {
      if (!plan.sessions.length && !plan.logs.length && !plan.tmpEntries.length && !plan.snapshots.length) break
      if (held?.compromised()) {
        skipped.push("The retention lock was lost, so retention stopped.")
        break
      }
      const applied = await applyCodexHomeRetentionPlan(inventory, plan, { isActive, now, skipped })
      for (const key of Object.keys(result.removed) as (keyof CodexHomeRetentionReport["removed"])[]) result.removed[key] += applied.removed[key]
      for (const threadId of applied.removedThreads) if (referenced.has(threadId)) removedReferenced.add(threadId)
      inventory = await inventoryCodexHome(home)
      plan = planCodexHomeRetention(inventory, planContext())
      const progressed = Object.values(applied.removed).some(count => count > 0)
      if (!progressed || !plan.overBudget) break
    }
    const after = measureCodexHome(inventory)
    result.after = after
    result.overBudget = budgetBytes !== undefined && after.bytes > budgetBytes
    result.protected = plan.protected
    if (removedReferenced.size) options.onReferencedRemoved?.(removedReferenced)
    return result
  }
  finally {
    await held?.release()
  }
}

/** A Driver that keeps a policy for a Codex home. The adapter registers one source for each Agent. */
export interface CodexHomeRetentionSource {
  /** Resume cursors that this Driver keeps in memory. */
  cursors: () => Iterable<unknown>
  /** Drops the in-memory cursors of these native thread IDs after retention removed their sessions. */
  invalidate: (threadIds: ReadonlySet<string>) => void
  policy: NormalizedRetention
  sessionStorePath?: string
}

/** How the invocation found its Codex home. */
export type CodexHomeKind = "configured" | "implicit" | "profile" | "temporary"

interface HomeState {
  active: Map<string, number>
  lastStartedAt?: number
  policyWarning?: string
  running?: Promise<CodexHomeRetentionReport | undefined>
  sources: Set<CodexHomeRetentionSource>
}

const homes = new Map<string, HomeState>()
const warned = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

/** Holds native thread IDs as active in one home until `release()`. */
export interface CodexHomeActivity {
  release: () => void
  track: (threadId: string | undefined) => void
}

function trackActivity(state: HomeState): CodexHomeActivity {
  const tracked: string[] = []
  let released = false
  return {
    release() {
      if (released) return
      released = true
      for (const threadId of tracked) {
        const count = (state.active.get(threadId) ?? 1) - 1
        if (count > 0) state.active.set(threadId, count)
        else state.active.delete(threadId)
      }
    },
    track(threadId) {
      if (!threadId || released) return
      const id = threadId.toLowerCase()
      tracked.push(id)
      state.active.set(id, (state.active.get(id) ?? 0) + 1)
    },
  }
}

function policyKey(policy: NormalizedRetention): string {
  return JSON.stringify([policy.maxAgeMs, policy.maxRecords, policy.maxSize])
}

async function runRetention(home: string, state: HomeState): Promise<CodexHomeRetentionReport | undefined> {
  const sources = [...state.sources]
  const policies = sources.map(source => source.policy)
  const keys = new Set(policies.map(policyKey))
  if (keys.size > 1) {
    const warning = [...keys].sort().join("|")
    if (state.policyWarning !== warning) {
      state.policyWarning = warning
      console.info(`[vitehub] Agents use different driver.retention policies for the Codex home ${home}. The strictest value of each limit applies.`)
    }
  }
  const referenced: string[] = []
  for (const source of sources) {
    for (const cursor of source.cursors()) {
      const id = providerNativeThreadId(cursor)
      if (id) referenced.push(id)
    }
  }
  const report = await pruneCodexHome({
    home,
    isActive: threadId => state.active.has(threadId),
    onReferencedRemoved(threadIds) {
      for (const source of sources) source.invalidate(threadIds)
    },
    policy: policies,
    referenced,
    sessionStorePaths: [...new Set(sources.flatMap(source => source.sessionStorePath ? [resolve(source.sessionStorePath)] : []))],
  })
  const removed = Object.values(report.removed).some(count => count > 0)
  if (removed || report.overBudget) console.info("[vitehub] Codex home retention", report)
  return report
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

/** Resolves the Codex home of an invocation in the same order as the provider runtime. */
export function resolveCodexHome(input: { credentialHome?: string, environmentHome?: string, providerSettings?: Record<string, unknown> }): string | undefined {
  if (input.credentialHome) return input.credentialHome
  const configured = input.providerSettings?.homePath
  if (hasRuntimeType(configured, "string") && configured.trim()) return resolve(expandHome(configured.trim()))
  if (input.environmentHome?.trim()) return resolve(expandHome(input.environmentHome.trim()))
  return process.env.CODEX_HOME?.trim() ? resolve(expandHome(process.env.CODEX_HOME.trim())) : undefined
}

export interface StartCodexHomeRetentionInput {
  /** The resolved home, or undefined for the implicit `~/.codex`. */
  home: string | undefined
  kind: CodexHomeKind
  /** With driver.launch, Codex can run in another container. */
  launch: boolean
  source: CodexHomeRetentionSource
  /** Native thread ID that the invocation resumes. It is active before retention starts. */
  threadId?: string
}

/**
 * Registers an invocation's Codex home and starts retention in the background when it is due:
 * on the first invocation for the home in this process, then at most every 10 minutes.
 * Runs for one home never overlap. Errors are logged and never fail the invocation.
 * Returns the activity lease that protects the invocation's threads, or undefined when the home is not eligible.
 */
export async function startCodexHomeRetention(input: StartCodexHomeRetentionInput, now = Date.now()): Promise<CodexHomeActivity | undefined> {
  if (input.kind === "temporary") return
  if (input.kind === "implicit" || !input.home) {
    warnOnce("implicit", "[vitehub] driver.retention does not prune the implicit Codex home ~/.codex. Set CODEX_HOME, driver.providerSettings.homePath, or driver.credentialProfile.")
    return
  }
  const home = await realpath(input.home).catch(() => resolve(input.home!))
  if (input.launch) {
    const reachable = await access(home, constants.R_OK | constants.W_OK).then(() => true, () => false)
    if (!reachable) {
      warnOnce(`launch:${home}`, `[vitehub] driver.retention cannot reach the Codex home ${home} in this process. With driver.launch, mount the home at the same path in the app container.`)
      return
    }
  }
  let state = homes.get(home)
  if (!state) {
    state = { active: new Map(), sources: new Set() }
    homes.set(home, state)
  }
  state.sources.add(input.source)
  const activity = trackActivity(state)
  activity.track(input.threadId)
  const due = state.lastStartedAt === undefined || now - state.lastStartedAt >= codexHomeRetentionIntervalMs
  if (due && !state.running) {
    state.lastStartedAt = now
    const current = state
    current.running = runRetention(home, current)
      .catch((error: unknown) => {
        console.warn(`[vitehub] Codex home retention failed for ${home}.`, error)
        return undefined
      })
      .finally(() => {
        current.running = undefined
      })
  }
  return activity
}

/** Waits for the retention run of a home, when one runs. For tests and graceful shutdown. */
export async function codexHomeRetentionIdle(home?: string): Promise<void> {
  const states = home ? [homes.get(await realpath(home).catch(() => resolve(home)))] : [...homes.values()]
  await Promise.all(states.map(state => state?.running))
}

/** Clears the process registry. For tests. */
export function resetCodexHomeRetention(): void {
  homes.clear()
  warned.clear()
}
