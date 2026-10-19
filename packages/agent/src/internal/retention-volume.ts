import { statfs } from "node:fs/promises"
import { dirname } from "node:path"

import type { RetentionSizeLimit } from "./retention-policy.ts"

const capacityCacheMs = 10 * 60 * 1000
const capacities = new Map<string, { capacity: number, checkedAt: number }>()

/**
 * Resolves a size limit to bytes. A percent is a share of the capacity of the volume that holds `storePath`.
 * The capacity is the volume's total size, read with statfs and cached for 10 minutes per directory.
 */
export async function retentionBudgetBytes(size: RetentionSizeLimit, storePath: string, now = Date.now()): Promise<number> {
  if ("bytes" in size) return size.bytes
  const directory = dirname(storePath)
  let cached = capacities.get(directory)
  if (!cached || now - cached.checkedAt >= capacityCacheMs) {
    const stats = await statfs(directory)
    cached = { capacity: stats.blocks * stats.bsize, checkedAt: now }
    capacities.set(directory, cached)
  }
  return Math.floor(size.fraction * cached.capacity)
}

/**
 * Returns up to `pages` free pages of a SQLite file with `auto_vacuum = INCREMENTAL` to the file system.
 * The libSQL client runs one step of `PRAGMA incremental_vacuum` and keeps its write lock, so this opens the file
 * with node:sqlite, which runs the statement to the end. A short busy timeout keeps a locked file from blocking the
 * event loop; the next prune frees the remaining pages.
 */
export async function incrementalVacuum(path: string, pages: number): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(path, { timeout: 100 })
  try {
    database.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`)
  }
  finally {
    database.close()
  }
}
