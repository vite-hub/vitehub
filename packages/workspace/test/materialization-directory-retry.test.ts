import { expect, it } from "vitest"

import { materializeWorkspaceSources, sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

it("retries removed Source directories after a transient Store failure", async () => {
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
  const remove = store.rm.bind(store)
  let fail = true
  store.rm = async (path, options) => {
    if (path === "docs/nested" && fail) {
      fail = false
      throw new Error("temporary Store failure")
    }
    await remove(path, options)
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

  await materializeWorkspaceSources(removed, store)
  await expect(store.stat("docs/nested")).resolves.toBeUndefined()
  await expect(store.stat("docs")).resolves.toBeUndefined()
  await expect(store.getMeta!(sourceSnapshotMetaKey(definition.name, "docs"))).resolves.toEqual({})
  await expect(store.getMeta!(`workspace:${definition.name}:startup-sources`)).resolves.toEqual([])
})
