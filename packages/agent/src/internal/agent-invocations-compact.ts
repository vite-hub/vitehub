import { constants, existsSync } from "node:fs"
import { access, stat, statfs } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { Client } from "@libsql/client"

export type JournalAutoVacuum = "full" | "incremental" | "none"

export interface JournalFileMeasurement {
  autoVacuum: JournalAutoVacuum
  fileBytes: number
  freelistCount: number
  /** Bytes of the pages that hold data: (page_count - freelist_count) * page_size. VACUUM shrinks the file to about this size. */
  liveBytes: number
  pageCount: number
  pageSize: number
  walBytes: number
}

export interface JournalCompactSpace {
  availableBytes: number
  directory: string
  requiredBytes: number
  /** What VACUUM writes to this volume: the journal next to the database, the temporary copy, or both. */
  uses: ("journal" | "temporary copy")[]
}

export interface JournalCompactResult {
  after?: JournalFileMeasurement
  before: JournalFileMeasurement
  database: string
  dryRun: boolean
  /** Bytes that the database file and its WAL gave back. Set after a compact. */
  reclaimedBytes?: number
  space: { ok: boolean, volumes: JournalCompactSpace[] }
  /** False when a reader kept the WAL checkpoint from truncating the WAL. Set after a compact. */
  walTruncated?: boolean
}

export interface JournalCompactOptions {
  busyTimeoutMs: number
  client: Client
  dryRun: boolean
  /** Bytes that an unprivileged process can write in a directory. Defaults to statfs. */
  freeSpace?: (directory: string) => Promise<number>
  label: string
  path: string
}

/** VACUUM can write a little more than the live data, for example while it rebuilds indexes. */
const spaceMargin = 1.1

const autoVacuumModes: Record<number, JournalAutoVacuum> = { 0: "none", 1: "full", 2: "incremental" }

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value ?? 0)
}

async function fileBytes(path: string): Promise<number> {
  return existsSync(path) ? (await stat(path)).size : 0
}

async function pragma(client: Client, name: string): Promise<number> {
  return numberValue((await client.execute(`PRAGMA ${name}`)).rows[0]?.[name])
}

async function measure(client: Client, path: string): Promise<JournalFileMeasurement> {
  const pageCount = await pragma(client, "page_count")
  const pageSize = await pragma(client, "page_size")
  const freelistCount = await pragma(client, "freelist_count")
  return {
    autoVacuum: autoVacuumModes[await pragma(client, "auto_vacuum")] ?? "none",
    fileBytes: await fileBytes(path),
    freelistCount,
    liveBytes: (pageCount - freelistCount) * pageSize,
    pageCount,
    pageSize,
    walBytes: await fileBytes(`${path}-wal`),
  }
}

async function writableDirectory(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) return false
    await access(directory, constants.W_OK | constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

/** The directory where SQLite writes the temporary copy that VACUUM builds. It uses the same search order as the SQLite Unix VFS. */
async function sqliteTemporaryDirectory(): Promise<string> {
  if (process.platform === "win32") return tmpdir()
  for (const candidate of [process.env.SQLITE_TMPDIR, process.env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp"]) {
    if (candidate && await writableDirectory(candidate)) return resolve(candidate)
  }
  return process.cwd()
}

async function statfsFreeSpace(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}

/**
 * VACUUM builds a copy of the live data in the SQLite temporary directory. Then it writes the copy back through
 * the WAL or the rollback journal next to the database. Both need about the live bytes. When both directories
 * are on the same volume, that volume needs both.
 */
async function checkSpace(path: string, before: JournalFileMeasurement, freeSpace: (directory: string) => Promise<number>) {
  const copyBytes = Math.ceil(before.liveBytes * spaceMargin)
  const databaseDirectory = dirname(path)
  const temporaryDirectory = await sqliteTemporaryDirectory()
  const journal: JournalCompactSpace = {
    availableBytes: await freeSpace(databaseDirectory),
    directory: databaseDirectory,
    requiredBytes: copyBytes + before.walBytes,
    uses: ["journal"],
  }
  const volumes = [journal]
  if ((await stat(databaseDirectory)).dev === (await stat(temporaryDirectory)).dev) {
    journal.requiredBytes += copyBytes
    journal.uses.push("temporary copy")
  }
  else {
    volumes.push({ availableBytes: await freeSpace(temporaryDirectory), directory: temporaryDirectory, requiredBytes: copyBytes, uses: ["temporary copy"] })
  }
  return { ok: volumes.every(volume => volume.availableBytes >= volume.requiredBytes), volumes }
}

function isSqliteLockError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as Error & { code?: unknown }).code
    if (typeof code === "string" && /^SQLITE_(BUSY|LOCKED)/.test(code)) return true
  }
  return false
}

/**
 * Rebuilds a local SQLite journal file with VACUUM and sets `auto_vacuum = INCREMENTAL`, so later size prunes shrink it.
 * A dry run only measures the file and the free space.
 */
export async function compactJournalFile(options: JournalCompactOptions): Promise<JournalCompactResult> {
  const { client, label, path } = options
  // A file that another process holds open waits for the lock this long, then compact fails instead of waiting forever.
  await client.execute(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`)
  const before = await measure(client, path)
  const space = await checkSpace(path, before, options.freeSpace ?? statfsFreeSpace)
  const result: JournalCompactResult = { before, database: label, dryRun: options.dryRun, space }
  if (options.dryRun) return result
  if (!space.ok) {
    const lines = space.volumes.map(volume => `${volume.directory} (${volume.uses.join(" and ")}): ${volume.availableBytes} bytes available, ${volume.requiredBytes} bytes required.`)
    throw agentDiagnostics.AGENT_R0931({
      message: [
        `Not enough free space to compact ${label}. VACUUM writes a copy of the ${before.liveBytes} live bytes and a journal of about the same size.`,
        ...lines,
        "Free space on the volume, or set SQLITE_TMPDIR to a directory on another volume for the temporary copy.",
      ].join("\n"),
    })
  }
  try {
    // auto_vacuum changes on an existing file only when VACUUM rebuilds it.
    // execute() runs one step of a statement. executeMultiple() runs the script to the end.
    await client.executeMultiple("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")
  }
  catch (error) {
    if (!isSqliteLockError(error)) throw error
    throw agentDiagnostics.AGENT_R0931({
      message: `${label} is busy. VACUUM needs the write lock, and another process held it for more than ${options.busyTimeoutMs} ms. Stop the server that uses the journal, or run compact during a quiet window.`,
    })
  }
  const checkpoint = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)")
  const after = await measure(client, path)
  return {
    ...result,
    after,
    reclaimedBytes: before.fileBytes + before.walBytes - after.fileBytes - after.walBytes,
    walTruncated: numberValue(checkpoint.rows[0]?.busy) === 0,
  }
}
