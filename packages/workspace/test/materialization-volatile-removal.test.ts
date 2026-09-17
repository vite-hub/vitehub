import { expect, it } from "vitest"

import type { WorkspaceStore } from "../src/core/types.ts"
import { normalizeWorkspaceSources } from "../src/sources/config.ts"
import { materializeWorkspaceSources, readCurrentSourceSnapshot, sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

const metadataModes = ["neither", "get-only", "set-only"] as const
type MetadataMode = typeof metadataModes[number]

function limitedStore(backing: WorkspaceStore, mode: MetadataMode): WorkspaceStore {
  return {
    readFile: backing.readFile.bind(backing),
    writeFile: backing.writeFile.bind(backing),
    list: backing.list.bind(backing),
    glob: backing.glob.bind(backing),
    stat: backing.stat.bind(backing),
    mkdir: backing.mkdir.bind(backing),
    rm: backing.rm.bind(backing),
    removeEmptyDirectory: backing.removeEmptyDirectory?.bind(backing),
    snapshot: backing.snapshot.bind(backing),
    diff: backing.diff.bind(backing),
    ...(mode === "get-only" ? { getMeta: backing.getMeta?.bind(backing) } : {}),
    ...(mode === "set-only" ? { setMeta: backing.setMeta?.bind(backing) } : {}),
  }
}

function definition(name: string, paths: string[]) {
  return {
    name,
    sources: { docs: {
      materialize: "startup" as const,
      mount: { path: "docs" },
      async getKeys() { return paths },
      async getItem(key: string) { return { key, content: `${name}:${key}` } },
    } },
  }
}

it.each(metadataModes)("removes startup Sources within one %s Store while preserving user edits", async (mode) => {
  const store = limitedStore(createMemoryWorkspaceStore(), mode)
  const source = definition("removed", ["nested/generated.md", "edited.md"])
  await materializeWorkspaceSources(source, store)
  const edited = await store.readFile("docs/edited.md")
  await store.writeFile("docs/edited.md", { ...edited, path: "docs/edited.md", content: "user edit" })

  await materializeWorkspaceSources({ ...source, sources: {} }, store)
  await materializeWorkspaceSources({ ...source, sources: {} }, store)

  await expect(store.readFile("docs/nested/generated.md")).resolves.toBeUndefined()
  await expect(store.stat("docs/nested")).resolves.toBeUndefined()
  await expect(store.readFile("docs/edited.md")).resolves.toMatchObject({ content: "user edit" })
  await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
})

it.each(metadataModes)("retries directory removal after a Store failure with %s metadata", async (mode) => {
  const store = limitedStore(createMemoryWorkspaceStore(), mode)
  const source = definition("retry", ["nested/generated.md"])
  await materializeWorkspaceSources(source, store)
  const remove = store.removeEmptyDirectory!.bind(store)
  let fail = true
  store.removeEmptyDirectory = async (path) => {
    if (path === "docs/nested" && fail) {
      fail = false
      throw new Error("temporary Store failure")
    }
    await remove(path)
  }

  await expect(materializeWorkspaceSources({ ...source, sources: {} }, store)).rejects.toThrow("temporary Store failure")
  await expect(store.stat("docs/nested")).resolves.toMatchObject({ type: "directory" })

  await materializeWorkspaceSources({ ...source, sources: {} }, store)
  await expect(store.stat("docs")).resolves.toBeUndefined()
})

it.each(metadataModes)("transfers shared directory ownership between Workspaces on a %s Store", async (mode) => {
  const store = limitedStore(createMemoryWorkspaceStore(), mode)
  const first = definition("first", ["nested/first.md", "nested/shared.md"])
  const second = definition("second", ["nested/second.md", "nested/shared.md"])
  await materializeWorkspaceSources(first, store)
  await materializeWorkspaceSources(second, store)

  await materializeWorkspaceSources({ ...first, sources: {} }, store)

  await expect(store.readFile("docs/nested/first.md")).resolves.toBeUndefined()
  await expect(store.readFile("docs/nested/second.md")).resolves.toMatchObject({ content: "second:nested/second.md" })
  await expect(store.readFile("docs/nested/shared.md")).resolves.toMatchObject({ content: "second:nested/shared.md" })

  await materializeWorkspaceSources({ ...second, sources: {} }, store)
  await expect(store.stat("docs/nested")).resolves.toBeUndefined()
  await expect(store.stat("docs")).resolves.toBeUndefined()
})

it.each(metadataModes)("does not transfer volatile cleanup ownership to a new %s Store instance", async (mode) => {
  const backing = createMemoryWorkspaceStore()
  const store = limitedStore(backing, mode)
  const source = definition("restarted", ["nested/generated.md"])
  await materializeWorkspaceSources(source, store)

  await materializeWorkspaceSources({ ...source, sources: {} }, limitedStore(backing, mode))

  await expect(backing.readFile("docs/nested/generated.md")).resolves.toMatchObject({ content: "restarted:nested/generated.md" })
  await materializeWorkspaceSources({ ...source, sources: {} }, store)
  await expect(backing.stat("docs")).resolves.toBeUndefined()
})

it("does not resurrect a persisted snapshot after cleanup through a get-only Store", async () => {
  const backing = createMemoryWorkspaceStore()
  const source = definition("persisted", ["generated.md", "edited.md"])
  await materializeWorkspaceSources(source, backing)
  const store = limitedStore(backing, "get-only")
  const [configuredSource] = normalizeWorkspaceSources(source.sources)
  await expect(readCurrentSourceSnapshot(store, source.name, configuredSource!)).resolves.toMatchObject({ status: "ready" })
  await store.writeFile("docs/edited.md", { path: "docs/edited.md", content: "user edit" })

  await materializeWorkspaceSources({ ...source, sources: {} }, store)

  await expect(store.readFile("docs/generated.md")).resolves.toBeUndefined()
  await expect(store.readFile("docs/edited.md")).resolves.toMatchObject({ content: "user edit" })
  await expect(readCurrentSourceSnapshot(store, source.name, configuredSource!)).resolves.toBeUndefined()
  // The read-only facade cannot change the persisted backend or other instances.
  await expect(readCurrentSourceSnapshot(backing, source.name, configuredSource!)).resolves.toMatchObject({ status: "ready" })
})

it("retains durable cleanup evidence when clearing the snapshot fails", async () => {
  const store = createMemoryWorkspaceStore()
  const source = definition("clear-retry", ["generated.md"])
  await materializeWorkspaceSources(source, store)
  const [configuredSource] = normalizeWorkspaceSources(source.sources)
  const setMeta = store.setMeta!.bind(store)
  let fail = true
  store.setMeta = async (key, value) => {
    if (key === sourceSnapshotMetaKey(source.name, "docs") && fail) {
      fail = false
      throw new Error("snapshot clear failed")
    }
    await setMeta(key, value)
  }

  await expect(materializeWorkspaceSources({ ...source, sources: {} }, store)).rejects.toThrow("snapshot clear failed")
  await expect(readCurrentSourceSnapshot(store, source.name, configuredSource!)).resolves.toMatchObject({ status: "ready" })
  await expect(store.getMeta!(`workspace:${source.name}:startup-sources`)).resolves.toEqual([{ key: "docs", mountPath: "docs" }])

  await materializeWorkspaceSources({ ...source, sources: {} }, store)
  await expect(readCurrentSourceSnapshot(store, source.name, configuredSource!)).resolves.toBeUndefined()
  await expect(store.getMeta!(`workspace:${source.name}:startup-sources`)).resolves.toEqual([])
})
