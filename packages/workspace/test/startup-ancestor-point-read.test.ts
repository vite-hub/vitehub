import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("startup ancestor point reads", () => {
  it.each(["stat", "exists"] as const)("materializes nested startup mounts on the first %s of their ancestor", async (operation) => {
    const store = createMemoryWorkspaceStore()
    const getKeys = vi.fn(async () => ["file.md"])
    const siblingKeys = vi.fn(async () => ["file.md"])
    const lazyKeys = vi.fn(async () => ["file.md"])
    const view = createWorkspaceSourceView({
      name: "startup-ancestor-point-read",
      sources: {
        generated: custom({ materialize: "startup", mount: "docs/generated", getKeys, async getItem(key) { return { key, content: "generated" } } }),
        sibling: custom({ materialize: "startup", mount: "docs-other/generated", getKeys: siblingKeys, async getItem(key) { return { key, content: "sibling" } } }),
        lazy: custom({ materialize: "lazy", mount: "docs/lazy", getKeys: lazyKeys, async getItem(key) { return { key, content: "lazy" } } }),
      },
    }, store)

    if (operation === "stat") await expect(view.stat("docs")).resolves.toMatchObject({ path: "docs", type: "directory" })
    else await expect(view.exists("docs")).resolves.toBe(true)

    await expect(store.readFile("docs/generated/file.md")).resolves.toMatchObject({ content: "generated" })
    expect(getKeys).toHaveBeenCalledTimes(1)
    expect(siblingKeys).not.toHaveBeenCalled()
    expect(lazyKeys).not.toHaveBeenCalled()
    await expect(store.stat("docs-other")).resolves.toBeUndefined()
    await expect(store.stat("docs/lazy")).resolves.toBeUndefined()
  })
})
