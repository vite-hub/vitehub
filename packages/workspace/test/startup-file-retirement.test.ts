import { describe, expect, it, vi } from "vitest"
import { custom } from "../src/index.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"

describe("startup file ownership", () => {
  it.each(["refresh", "retire"])("preserves same-byte attribute replacements during %s", async (operation) => {
    for (const attribute of ["mediaType", "metadata"] as const) {
      const store = createMemoryWorkspaceStore()
      let keys = ["file.md"]
      const sources = { generated: custom({
        materialize: "startup",
        async getKeys() { return keys },
        async getItem(key) { return { key, content: "generated", mediaType: "text/markdown", metadata: { original: true } } },
      }) }
      const view = createWorkspaceSourceView({ name: "attribute-retirement", sources }, store)
      await view.materializeSources()
      const path = "generated/file.md"
      const file = (await store.readFile(path))!
      const replacement = {
        ...file,
        mediaType: attribute === "mediaType" ? "text/plain" : file.mediaType,
        metadata: attribute === "metadata" ? { user: true } : undefined,
      }
      await store.writeFile(path, replacement)
      keys = []
      if (operation === "retire") Reflect.deleteProperty(sources, "generated")
      await view.materializeSources()
      await view.materializeSources()
      await expect(store.readFile(path)).resolves.toMatchObject(replacement)
    }
  })

  it.each(["refresh", "retire"])("retains files without complete-file removal during %s", async (operation) => {
    const store = createMemoryWorkspaceStore()
    let keys = ["file.md"]
    const sources = { generated: custom({ materialize: "startup", async getKeys() { return keys }, async getItem(key) { return { key, content: "generated" } } }) }
    const view = createWorkspaceSourceView({ name: "without-conditional-file-removal", sources }, store)
    await view.materializeSources()
    const path = "generated/file.md"
    const file = await store.readFile(path)
    Object.defineProperty(store, "compareAndSwapFile", { value: undefined })
    keys = []
    if (operation === "retire") Reflect.deleteProperty(sources, "generated")
    await view.materializeSources()
    await expect(store.readFile(path)).resolves.toEqual(file)
  })

  it.each(["refresh", "retire"])("preserves concurrent attribute replacements during %s", async (operation) => {
    for (const attribute of ["mediaType", "metadata"] as const) {
      const store = createMemoryWorkspaceStore()
      let keys = ["file.md"]
      const sources = { generated: custom({ materialize: "startup", async getKeys() { return keys }, async getItem(key) { return { key, content: "generated", mediaType: "text/markdown", metadata: { original: true } } } }) }
      const view = createWorkspaceSourceView({ name: "removal-race", sources }, store)
      await view.materializeSources()
      const path = "generated/file.md"
      const file = (await store.readFile(path))!
      const replacement = {
        ...file,
        mediaType: attribute === "mediaType" ? "text/plain" : file.mediaType,
        metadata: attribute === "metadata" ? { ...file.metadata, user: true } : file.metadata,
      }
      const remove = store.compareAndSwapFile!.bind(store)
      const spy = vi.spyOn(store, "compareAndSwapFile").mockImplementation(async (target, expected, next) => {
        if (target === path) await store.writeFile(path, replacement)
        await remove(target, expected, next)
      })
      try {
        keys = []
        if (operation === "retire") Reflect.deleteProperty(sources, "generated")
        await view.materializeSources()
        expect(spy).toHaveBeenCalled()
        await view.materializeSources()
        await expect(store.readFile(path)).resolves.toEqual(replacement)
      }
      finally { spy.mockRestore() }
    }
  })
})
