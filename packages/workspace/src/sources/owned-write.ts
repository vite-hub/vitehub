import { markWorkspaceFileRemoval, readWorkspaceFileOwner, recordWorkspaceFileOwner, removeWorkspaceFileOwner, removeWorkspaceOwnedFile } from "./file-ownership.ts"
import type { WorkspaceStore } from "../core/types.ts"

// Call inside the Store mutation queue so rollback cannot undo another Source write.
export async function withWorkspaceFileCheckpoint<T>(store: WorkspaceStore, path: string, write: () => Promise<T>, checkpoint: (result: T) => Promise<void>, rollbackCheckpoint?: () => Promise<void>): Promise<T> {
  const previous = (await store.stat(path))?.type === "file" ? await store.readFile(path) : undefined
  const owner = await readWorkspaceFileOwner(store, path)
  const result = await write()
  try {
    await checkpoint(result)
  }
  catch (error) {
    try {
      if (previous) {
        // Bind cleanup to the failed write before restoring unowned bytes. A
        // failed owner clear must not claim the restored file after Store reopen.
        if (!owner) await markWorkspaceFileRemoval(store, path)
        await store.writeFile(path, previous)
        try {
          if (owner) await recordWorkspaceFileOwner(store, path, owner)
          else await removeWorkspaceFileOwner(store, path)
        }
        finally {
          await rollbackCheckpoint?.()
        }
      }
      else {
        await removeWorkspaceOwnedFile(store, path)
        await rollbackCheckpoint?.()
      }
    }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Workspace file checkpoint and rollback failed for "${path}".`)
    }
    throw error
  }
  return result
}
