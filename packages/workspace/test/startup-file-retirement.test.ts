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

  it.each(["refresh", "retire"])("preserves a replacement made at conditional removal during %s", async (operation) => {
    const store = createMemoryWorkspaceStore()
    let keys = ["file.md"]
    const sources = { generated: custom({ materialize: "startup", async getKeys() { return keys }, async getItem(key) { return { key, content: "generated" } } }) }
    const view = createWorkspaceSourceView({ name: "removal-race", sources }, store)
    await view.materializeSources()
    const path = "generated/file.md"
    const remove = store.rm.bind(store)
    const spy = vi.spyOn(store, "rm").mockImplementation(async (target, options) => {
      if (target === path) await store.writeFile(path, { path, content: "generated", metadata: { user: true } })
      await remove(target, options)
    })
    try {
      keys = []
      if (operation === "retire") Reflect.deleteProperty(sources, "generated")
      await view.materializeSources()
      await expect(store.readFile(path)).resolves.toMatchObject({ metadata: { user: true } })
    }
    finally { spy.mockRestore() }
  })
})
