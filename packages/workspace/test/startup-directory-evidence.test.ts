import { afterEach, expect, it, vi } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { invalidateStartupDirectoryRemoval, removedStartupDirectoryMetaKey } from "../src/sources/startup-directory-evidence.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
})

it.each([
  ["after-cleanup", "directory-evidence"],
  ["checkpoint", "directory-evidence"],
  ["before-removal", "directory-evidence"],
  ["after-cleanup", "other-workspace"],
  ["checkpoint", "other-workspace"],
  ["before-removal", "other-workspace"],
])("keeps recursive user removals visible during %s through %s", async (mutationPhase, writerName) => {
  const store = createMemoryWorkspaceStore()
  const sources = { generated: custom({ materialize: "startup", files: [{ path: "nested/file.md", content: "generated" }] }) }
  registerWorkspace("directory-evidence", defineWorkspace({ store, sources }))
  const workspace = await useRegisteredWorkspace("directory-evidence")
  await workspace.materializeSources?.()
  await workspace.snapshot()
  Reflect.deleteProperty(sources, "generated")
  const writer = createWorkspaceSourceView({ name: writerName, sources: {} }, store)
  let checkpointed = false
  const recreateAndRemove = async () => {
    if (mutationPhase === "after-cleanup") {
      await writer.mkdir("generated/nested", { recursive: true })
      await writer.rm("generated", { recursive: true })
      return
    }
    // These mutations have already passed the view's startup reconciliation
    // barrier when cleanup yields to the Store operation below.
    await store.mkdir("generated/nested", { recursive: true })
    await invalidateStartupDirectoryRemoval(store, "generated/nested")
    await store.rm("generated", { recursive: true })
    await invalidateStartupDirectoryRemoval(store, "generated")
  }
  const setMeta = store.setMeta!.bind(store)
  if (mutationPhase === "checkpoint") {
    vi.spyOn(store, "setMeta").mockImplementation(async (key, value) => {
      if (!checkpointed && key === removedStartupDirectoryMetaKey("directory-evidence", "generated/nested")) {
        checkpointed = true
        await recreateAndRemove()
      }
      await setMeta(key, value)
    })
  }
  if (mutationPhase === "before-removal") {
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (path, options) => {
      if (!checkpointed && path === "generated/nested") {
        checkpointed = true
        await recreateAndRemove()
      }
      return await list(path, options)
    })
  }
  await workspace.materializeSources?.()
  if (mutationPhase !== "after-cleanup") expect(checkpointed).toBe(true)
  else {
    expect((await workspace.diff()).entries).toEqual([])
    await recreateAndRemove()
  }
  const diff = await workspace.diff()
  for (const path of ["generated", "generated/nested"]) {
    expect(diff.entries).toContainEqual(expect.objectContaining({ path, type: "removed" }))
  }
})
