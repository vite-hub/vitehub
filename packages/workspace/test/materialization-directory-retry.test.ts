import { expect, it } from "vitest"

import { materializeWorkspaceSources, sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceStore } from "../src/core/types.ts"

it.each([false, true])("retries removed Source directories after a transient Store failure with concurrent content=%s", async (concurrentContent) => {
  const store = createMemoryWorkspaceStore()
  const definition = {
    name: "directory-retry",
    sources: { docs: {
      materialize: "startup" as const,
      mount: { path: "docs" },
      async getKeys() { return ["nested/file.md"] },
      async getItem(key: string) { return { key, content: "generated" } },
    } },
  }
  await materializeWorkspaceSources(definition, store)
  const remove = store.removeEmptyDirectory!.bind(store)
  let fail = true
  store.removeEmptyDirectory = async (path) => {
    if (path === "docs/nested" && fail) {
      fail = false
      if (concurrentContent) await store.writeFile("docs/nested/user.md", { path: "docs/nested/user.md", content: "user content" })
      throw new Error("temporary Store failure")
    }
    await remove(path)
  }
  const removed = { ...definition, sources: {} }

  await expect(materializeWorkspaceSources(removed, store)).rejects.toThrow("temporary Store failure")
  await expect(store.readFile("docs/nested/file.md")).resolves.toBeUndefined()
  await expect(store.getMeta!(sourceSnapshotMetaKey(definition.name, "docs"))).resolves.toMatchObject({
    ownedDirectories: expect.arrayContaining(["docs/nested"]),
  })
  await expect(store.getMeta!(`workspace:${definition.name}:startup-sources`)).resolves.toEqual([
    { key: "docs", mountPath: "docs" },
  ])

  if (concurrentContent) {
    await expect(store.readFile("docs/nested/user.md")).resolves.toMatchObject({ content: "user content" })
    await store.rm("docs/nested/user.md")
  }
  await materializeWorkspaceSources(removed, store)
  await expect(store.stat("docs/nested")).resolves.toBeUndefined()
  await expect(store.stat("docs")).resolves.toBeUndefined()
  await expect(store.getMeta!(sourceSnapshotMetaKey(definition.name, "docs"))).resolves.toEqual({})
  await expect(store.getMeta!(`workspace:${definition.name}:startup-sources`)).resolves.toEqual([])
})

it("keeps directories containing user content without attempting removal", async () => {
  const store = createMemoryWorkspaceStore()
  const definition = {
    name: "directory-user-content",
    sources: { docs: {
      materialize: "startup" as const,
      mount: { path: "docs" },
      async getKeys() { return ["nested/file.md"] },
      async getItem(key: string) { return { key, content: "generated" } },
    } },
  }
  await materializeWorkspaceSources(definition, store)
  await store.writeFile("docs/nested/user.md", { path: "docs/nested/user.md", content: "user content" })
  const remove = store.rm.bind(store)
  store.rm = async (path, options) => {
    if (path === "docs/nested" || path === "docs") throw new Error("retained directory must not be removed")
    await remove(path, options)
  }

  await materializeWorkspaceSources({ ...definition, sources: {} }, store)

  await expect(store.readFile("docs/nested/file.md")).resolves.toBeUndefined()
  await expect(store.readFile("docs/nested/user.md")).resolves.toMatchObject({ content: "user content" })
  await expect(store.getMeta!(sourceSnapshotMetaKey(definition.name, "docs"))).resolves.toEqual({})
  await expect(store.getMeta!(`workspace:${definition.name}:startup-sources`)).resolves.toEqual([])
})

it.each(["refresh", "remove"])("preserves a file replacing an owned directory during %s", async (operation) => {
  const store = createMemoryWorkspaceStore()
  let keys = ["nested/file.md"]
  const definition = {
    name: "directory-replacement",
    sources: { docs: {
      materialize: "startup" as const,
      mount: { path: "docs" },
      async getKeys() { return keys },
      async getItem(key: string) { return { key, content: "generated" } },
    } },
  }
  await materializeWorkspaceSources(definition, store)
  const removeDirectory = store.removeEmptyDirectory!.bind(store)
  let replaced = false
  store.removeEmptyDirectory = async (path) => {
    if (path === "docs/nested") {
      await store.rm(path)
      await store.writeFile(path, { path, content: "foreign file" })
      replaced = true
    }
    await removeDirectory(path)
  }
  keys = []

  await materializeWorkspaceSources(operation === "remove" ? { ...definition, sources: {} } : definition, store)

  expect(replaced).toBe(true)
  await expect(store.readFile("docs/nested")).resolves.toMatchObject({ content: "foreign file" })
})

it.each(["refresh", "remove"])("retains directory ownership without atomic removal during %s", async (operation) => {
  const memory = createMemoryWorkspaceStore()
  const store: WorkspaceStore = memory
  let keys = ["nested/file.md"]
  const definition = {
    name: "directory-without-atomic-removal",
    sources: { docs: {
      materialize: "startup" as const,
      mount: { path: "docs" },
      async getKeys() { return keys },
      async getItem(key: string) { return { key, content: "generated" } },
    } },
  }
  await materializeWorkspaceSources(definition, store)
  const removeDirectory = memory.removeEmptyDirectory!.bind(memory)
  store.removeEmptyDirectory = undefined
  keys = []
  const next = operation === "remove" ? { ...definition, sources: {} } : definition

  await materializeWorkspaceSources(next, store)

  await expect(store.stat("docs/nested")).resolves.toMatchObject({ type: "directory" })
  await expect(store.getMeta!(sourceSnapshotMetaKey(definition.name, "docs"))).resolves.toMatchObject({
    ownedDirectories: expect.arrayContaining(["docs/nested"]),
  })
  store.removeEmptyDirectory = removeDirectory
  await materializeWorkspaceSources(next, store)
  await expect(store.stat("docs/nested")).resolves.toBeUndefined()
})
