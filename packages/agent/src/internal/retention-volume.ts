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
