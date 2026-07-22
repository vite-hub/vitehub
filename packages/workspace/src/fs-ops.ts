import { posix } from "node:path"

import { isWorkspaceError, workspaceError } from "./core/errors.ts"

import type { Workspace } from "./core/types.ts"

export async function ensureMissingOrReplaceable(workspace: Workspace, path: string, overwrite = false): Promise<void> {
  if (!await workspace.exists(path)) return
  if (!overwrite) throw workspaceError(`[vitehub] Workspace path already exists: ${path}.`)
  await workspace.rm(path, { recursive: true, force: true })
}

export async function copyWorkspacePath(workspace: Workspace, from: string, to: string, overwrite = false): Promise<void> {
  if (from === to) throw workspaceError("[vitehub] Source and destination must be different.")

  const source = await workspace.stat(from)
  if (source.type === "directory" && to.startsWith(`${from}/`)) {
    throw workspaceError("[vitehub] Destination cannot be nested inside the source directory.")
  }

  await ensureMissingOrReplaceable(workspace, to, overwrite)

  if (source.type === "file") {
    const content = await workspace.readFile(from, { encoding: "binary" })
    await workspace.writeFile(to, content, { mediaType: source.mediaType })
    return
  }

  const entries = await workspace.list(from, { recursive: true })
  await workspace.mkdir(to, { recursive: true })

  const directories = entries.filter(entry => entry.type === "directory").sort((left, right) => left.path.length - right.path.length)
  for (const entry of directories) {
    await workspace.mkdir(posix.join(to, posix.relative(from, entry.path)), { recursive: true })
  }

  await Promise.all(entries.filter(entry => entry.type === "file").map(async (entry) => {
    const content = await workspace.readFile(entry.path, { encoding: "binary" })
    await workspace.writeFile(posix.join(to, posix.relative(from, entry.path)), content, { mediaType: entry.mediaType })
  }))
}

export async function appendWorkspaceFile(workspace: Workspace, path: string, content: string): Promise<void> {
  let current = ""
  try {
    current = String(await workspace.readFile(path))
  }
  catch (error) {
    if (!isWorkspaceError(error)) throw error
  }
  await workspace.writeFile(path, `${current}${content}`)
}
