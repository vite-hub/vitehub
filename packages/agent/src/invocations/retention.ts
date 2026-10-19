/**
 * Count retention reads about `maxRecords` rows to find its cutoff. Age retention reads only the rows it deletes.
 * Stores run the count limit on about 1 in `ceil(maxRecords / 100)` prunes, so the terminal record count
 * can exceed `maxRecords` by about 1% between runs. Limits of 100 or fewer apply on every prune.
 */
export function countRetentionDue(maxRecords: false | number): boolean {
  return maxRecords !== false && Math.random() * Math.ceil(maxRecords / 100) < 1
}

export interface SizeRetentionCadence {
  /** Counts bytes that a committed write added. */
  record(bytes: number): void
  /** True when the store should measure its size: on the first check, after enough writes, or after 60 s with writes. */
  due(budgetBytes: number | undefined, now?: number): boolean
  /** Marks a completed measurement. */
  checked(now?: number): void
}

/**
 * Measuring the size of a store is cheap, but deleting to fit the budget is not. A store checks its size after a write
 * when it has never checked, when the writes since the last check reach max(64 KiB, budget / 100), or when 60 s have
 * passed and something was written.
 */
export function createSizeRetentionCadence(): SizeRetentionCadence {
  let checkedAt: number | undefined
  let written = 0
  return {
    record(bytes) {
      written += bytes
    },
    due(budgetBytes, now = Date.now()) {
      if (checkedAt === undefined) return true
      if (written <= 0) return false
      return written >= Math.max(64 * 1024, (budgetBytes ?? 0) / 100) || now - checkedAt >= 60_000
    },
    checked(now = Date.now()) {
      checkedAt = now
      written = 0
    },
  }
}
