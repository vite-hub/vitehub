import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("startup snapshot precedence", () => {
  it.each([false, true].flatMap(fileMetadata => ["none", "foreign owner", "concurrent content"].map(replacement => ({ fileMetadata, replacement }))))("recovers startup snapshots with file metadata=$fileMetadata and replacement=$replacement", async ({ fileMetadata, replacement }) => {
    const store = createMemoryWorkspaceStore()
    const writeFile = store.writeFile.bind(store)
    if (!fileMetadata) {
      const writeFileConditional = store.writeFileConditional!.bind(store)
      store.writeFile = async (path, file) => await writeFile(path, { path: file.path, content: file.content })
      store.writeFileConditional = async (path, file, ifDigest) => await writeFileConditional(path, { path: file.path, content: file.content }, ifDigest)
    }
    let higherContent = "preserved higher-priority content"
    let recovering = false
    const getHigherItem = vi.fn(async (key: string) => ({ key, content: higherContent }))
    const getLowerItem = vi.fn(async (key: string) => {
      if (recovering && key === "missing.md" && replacement === "foreign owner") {
        await writeFile("shared.md", { path: "shared.md", content: "lower-priority content", metadata: { source: "other" } })
      }
      return { key, content: "lower-priority content" }
    })
    const definition = {
      name: "startup-snapshot-precedence",
      sources: {
        higher: custom({ materialize: "startup", mount: "", async getKeys() { return ["shared.md"] }, getItem: getHigherItem }),
        lower: custom({ materialize: "startup", mount: "", async getKeys() { return ["shared.md", "missing.md"] }, getItem: getLowerItem }),
      },
    }
    await createWorkspaceSourceView(definition, store).list("")
    await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: higherContent })
    expect(getHigherItem).toHaveBeenCalledTimes(1)
    higherContent = "new provider content"
    await store.rm("missing.md")
    recovering = true
    if (replacement === "concurrent content") {
      const writeFileConditional = store.writeFileConditional!.bind(store)
      store.writeFileConditional = async (path, file, ifDigest) => {
        if (path === "shared.md") await writeFile(path, { path, content: "concurrent user content" })
        await writeFileConditional(path, file, ifDigest)
      }
    }

    const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
    await inspection.list("")

    await expect(store.readFile("missing.md")).resolves.toMatchObject({ content: "lower-priority content" })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({
      content: replacement === "none" ? "preserved higher-priority content" : replacement === "foreign owner" ? "lower-priority content" : "concurrent user content",
      ...(replacement === "foreign owner" ? { metadata: { source: "other" } } : {}),
    })
    expect(getHigherItem).toHaveBeenCalledTimes(1)
    expect(getLowerItem).toHaveBeenCalledTimes(4)
  })
})
