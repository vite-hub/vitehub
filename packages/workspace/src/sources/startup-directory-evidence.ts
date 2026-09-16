import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { WorkspaceStore } from "../core/types.ts"

export function removedStartupDirectoryMetaKey(workspaceName: string | undefined, path: string) {
  return `workspace:${workspaceName || "default"}:removed-startup-directory:${JSON.stringify(path)}`
}

// Mutations belong to the shared Store tree, while removal evidence belongs
// to the Workspace that recorded it. Every writer must invalidate that evidence.
function mutationKey(path: string, kind: "path" | "tree") {
  return `workspace:startup-directory-mutation:${kind}:${JSON.stringify(path)}`
}

function ancestors(path: string) {
  const parts = path.split("/").filter(Boolean)
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))]
}

// Capture before removal. A checkpoint may run after a user has recreated and
// removed the directory, so its time of publication cannot prove ownership.
export async function captureStartupDirectoryRemoval(store: WorkspaceStore, path: string, baseline: string | undefined) {
  return { baseline, mutations: await captureStartupPathMutations(store, path) }
}

export async function captureStartupPathMutations(store: WorkspaceStore, path: string) {
  const keys = [mutationKey(path, "path"), ...ancestors(path).map(parent => mutationKey(parent, "tree"))]
  return await Promise.all(keys.map(async key => await store.getMeta?.(key) ?? null))
}

export async function removedStartupDirectoryMatches(store: WorkspaceStore, workspaceName: string | undefined, path: string, baseline: string) {
  const evidence = await store.getMeta?.(removedStartupDirectoryMetaKey(workspaceName, path))
  return isDeepStrictEqual(evidence, await captureStartupDirectoryRemoval(store, path, baseline))
}

export async function invalidateStartupDirectoryRemoval(store: WorkspaceStore, path: string) {
  const mutation = randomUUID()
  // The tree token invalidates descendants even after recursive removal has
  // made them impossible to enumerate. Path tokens invalidate parent evidence.
  await store.setMeta?.(mutationKey(path, "tree"), mutation)
  for (const parent of ancestors(path)) {
    await store.setMeta?.(mutationKey(parent, "path"), mutation)
  }
}
