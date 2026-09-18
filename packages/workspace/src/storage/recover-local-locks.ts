import { readdir, lstat, rm, rename } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { resolve, join } from "node:path"
import { workspaceError } from "../core/errors.ts"

/**
 * Remove abandoned markers from a trusted, exclusively owned local store.
 * Stop all store users and prevent changes to the store and its ancestor directories
 * for the entire call. Path checks catch existing symlinks; they do not provide
 * protection against concurrent filesystem mutation.
 */
export async function recoverLocalWorkspaceLocks(options: {
  root: string
  offline: true
}): Promise<{ removed: number }> {
  if (options.offline !== true)
    throw workspaceError("[vitehub] Workspace lock recovery requires exclusive offline access.")
  const root = resolve(options.root)
  const directory = join(root, ".vitehub", "locks")
  for (const path of [root, join(root, ".vitehub"), directory]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) return { removed: 0 }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw workspaceError(`[vitehub] Expected a real Workspace lock recovery directory: ${path}.`)
  }
  let removed = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.(gate|readers)$/.test(entry.name)) continue
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw workspaceError(`[vitehub] Expected a real Workspace lock marker directory: ${entry.name}.`)
    const marker = join(directory, entry.name)
    // Move the validated marker out of its public name before recursive removal.
    // This prevents a replacement at the original pathname from being followed.
    const quarantine = join(directory, `.recovery-${entry.name}-${randomUUID()}`)
    await rename(marker, quarantine)
    await rm(quarantine, { recursive: true })
    removed++
  }
  return { removed }
}
