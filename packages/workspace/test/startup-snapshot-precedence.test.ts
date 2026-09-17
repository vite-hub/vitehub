import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("startup snapshot precedence", () => {
  it.each([false, true].flatMap(fileMetadata => ["none", "foreign owner", "concurrent content", "concurrent metadata", "concurrent mediaType"].map(replacement => ({ fileMetadata, replacement }))))("recovers startup snapshots with file metadata=$fileMetadata and replacement=$replacement", async ({ fileMetadata, replacement }) => {
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
    if (replacement.startsWith("concurrent")) {
      const compareAndSwapFile = store.compareAndSwapFile!.bind(store)
      store.compareAndSwapFile = async (path, expected, file) => {
        if (path === "shared.md") {
          await writeFile(path, {
            ...expected,
            ...(replacement === "concurrent content" ? { content: "concurrent user content" } : {}),
            ...(replacement === "concurrent metadata" ? { metadata: { ...expected.metadata, owner: "user" } } : {}),
            ...(replacement === "concurrent mediaType" ? { mediaType: "text/user" } : {}),
          })
        }
        await compareAndSwapFile(path, expected, file)
      }
    }

    const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
    await inspection.list("")

    await expect(store.readFile("missing.md")).resolves.toMatchObject({ content: "lower-priority content" })
    await expect(store.readFile("shared.md")).resolves.toMatchObject({
      content: replacement === "none" ? "preserved higher-priority content" : replacement === "concurrent content" ? "concurrent user content" : "lower-priority content",
      ...(replacement === "foreign owner" ? { metadata: { source: "other" } } : {}),
      ...(replacement === "concurrent metadata" ? { metadata: { owner: "user" } } : {}),
      ...(replacement === "concurrent mediaType" ? { mediaType: "text/user" } : {}),
    })
    expect(getHigherItem).toHaveBeenCalledTimes(1)
    expect(getLowerItem).toHaveBeenCalledTimes(4)
  })

  it("preserves a file replacing an ancestor of a nested startup mount", async () => {
    const store = createMemoryWorkspaceStore()
    const getItem = vi.fn(async (key: string) => ({ key, content: "generated" }))
    const definition = {
      name: "replaced-startup-ancestor",
      sources: {
        generated: custom({ materialize: "startup", mount: "docs/nested", async getKeys() { return ["file.md"] }, getItem }),
      },
    }
    await createWorkspaceSourceView(definition, store).list("")
    await store.rm("docs", { recursive: true })
    await store.writeFile("docs", { path: "docs", content: "user" })
    expect(await store.stat("docs/nested")).toBeUndefined()

    const inspection = createWorkspaceSourceView(definition, store, { reuseStartupSnapshots: true })
    await inspection.list("")

    await expect(store.readFile("docs")).resolves.toMatchObject({ content: "user" })
    await expect(store.stat("docs/nested")).resolves.toBeUndefined()
    expect(getItem).toHaveBeenCalledTimes(1)
  })
})
