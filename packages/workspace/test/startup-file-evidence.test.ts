import { afterEach, expect, it, vi } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { removedStartupPathMetaKey } from "../src/sources/materialization.ts"
import { invalidateStartupDirectoryRemoval } from "../src/sources/startup-directory-evidence.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
})

it.each(["refresh", "retirement"])("keeps shared Store file deletions visible after startup %s", async (operation) => {
  const store = createMemoryWorkspaceStore()
  let keys = ["file.md"]
  const sources = { generated: custom({
    materialize: "startup",
    async getKeys() { return keys },
    async getItem(key) { return { key, content: "generated" } },
  }) }
  registerWorkspace("file-evidence", defineWorkspace({ store, sources }))
  const workspace = await useRegisteredWorkspace("file-evidence")
  await workspace.materializeSources?.()
  await workspace.snapshot()
  if (operation === "retirement") Reflect.deleteProperty(sources, "generated")
  else keys = []
  await workspace.materializeSources?.()
  expect((await workspace.diff()).entries).toEqual([])

  const writer = createWorkspaceSourceView({ name: "other-workspace", sources: {} }, store)
  await writer.writeFile("generated/file.md", "user")
  await writer.rm("generated/file.md")
  expect((await workspace.diff()).entries).toContainEqual(expect.objectContaining({ path: "generated/file.md", type: "removed" }))
})

it("keeps file deletions visible when another writer runs before the cleanup checkpoint", async () => {
  const store = createMemoryWorkspaceStore()
  const sources = { generated: custom({ materialize: "startup", files: [{ path: "file.md", content: "generated" }] }) }
  registerWorkspace("file-checkpoint", defineWorkspace({ store, sources }))
  const workspace = await useRegisteredWorkspace("file-checkpoint")
  await workspace.materializeSources?.()
  await workspace.snapshot()
  Reflect.deleteProperty(sources, "generated")
  const setMeta = store.setMeta!.bind(store)
  let checkpointed = false
  vi.spyOn(store, "setMeta").mockImplementation(async (key, value) => {
    if (!checkpointed && key === removedStartupPathMetaKey("file-checkpoint", "generated/file.md")) {
      checkpointed = true
      // The writer passed the view's reconciliation barrier before cleanup.
      await store.writeFile("generated/file.md", { path: "generated/file.md", content: "user" })
      await invalidateStartupDirectoryRemoval(store, "generated/file.md")
      await store.rm("generated/file.md")
      await invalidateStartupDirectoryRemoval(store, "generated/file.md")
    }
    await setMeta(key, value)
  })
  await workspace.materializeSources?.()
  expect(checkpointed).toBe(true)
  expect((await workspace.diff()).entries).toContainEqual(expect.objectContaining({ path: "generated/file.md", type: "removed" }))
})

it.each([
  { ifDigest: "stale" },
  { ifSource: "stale" },
  { ifWorkspace: "stale" },
  { ifDirectoryIdentity: "stale" },
])("preserves cleanup evidence after a conditional removal no-op with %j", async (condition) => {
  const store = createMemoryWorkspaceStore()
  const sources = { generated: custom({ materialize: "startup", files: [{ path: "nested/file.md", content: "generated" }] }) }
  registerWorkspace("conditional-evidence", defineWorkspace({ store, sources }))
  const workspace = await useRegisteredWorkspace("conditional-evidence")
  await workspace.materializeSources?.()
  await workspace.snapshot()
  Reflect.deleteProperty(sources, "generated")
  await workspace.materializeSources?.()
  expect((await workspace.diff()).entries).toEqual([])

  const writer = createWorkspaceSourceView({ name: "other-workspace", sources: {} }, store)
  const onRemove = vi.fn()
  await writer.rm("generated", { ...condition, recursive: true, onRemove })
  await writer.rm("generated/nested/file.md", { ...condition, onRemove })
  expect(onRemove).not.toHaveBeenCalled()
  expect((await workspace.diff()).entries).toEqual([])

  await writer.writeFile("generated/nested/file.md", "user")
  const before = (await workspace.diff()).entries
  await writer.rm("generated", { ...condition, recursive: true, onRemove })
  await writer.rm("generated/nested/file.md", { ...condition, onRemove })
  expect(onRemove).not.toHaveBeenCalled()
  expect((await workspace.diff()).entries).toEqual(before)
  await writer.rm("generated/nested/file.md", { ifSource: null, onRemove })
  expect(onRemove).toHaveBeenCalledOnce()
  expect((await workspace.diff()).entries).toContainEqual(expect.objectContaining({ path: "generated/nested/file.md", type: "removed" }))
})
