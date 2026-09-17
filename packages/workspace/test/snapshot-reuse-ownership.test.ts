import { expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

it("recreates a removed empty startup mount on a normal listing", async () => {
  const store = createMemoryWorkspaceStore()
  const view = createWorkspaceSourceView({
    name: "empty-startup-mount",
    sources: { docs: custom({ materialize: "startup", mount: "docs", files: [] }) },
  }, store)
  await view.list("")
  await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
  await store.rm("docs")
  await view.list("")
  await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
})

it("reuses unchanged items through durable ownership when stat omits metadata", async () => {
  const store = createMemoryWorkspaceStore()
  const stat = store.stat.bind(store)
  store.stat = async (path) => {
    const entry = await stat(path)
    return entry && { ...entry, metadata: undefined }
  }
  const getItem = vi.fn(async (key: string) => ({ key, content: "generated" }))
  const definition = {
    name: "durable-item-reuse",
    sources: { docs: {
      materialize: "startup" as const,
      mount: { path: "docs" },
      async getKeys() { return ["file.md"] },
      async getMeta() { return { etag: "stable" } },
      getItem,
    } },
  }
  await materializeWorkspaceSources(definition, store)
  await expect(materializeWorkspaceSources(definition, store)).resolves.toMatchObject({
    sources: [{ counts: { unchanged: 1 } }],
  })
  expect(getItem).toHaveBeenCalledTimes(1)
  await store.writeFile("docs/file.md", { path: "docs/file.md", content: "external edit" })
  await materializeWorkspaceSources(definition, store)
  expect(getItem).toHaveBeenCalledTimes(2)
  await expect(store.readFile("docs/file.md")).resolves.toMatchObject({ content: "generated" })
})

it("reuses an empty startup snapshot after intentionally cleaning its mount", async () => {
  const store = createMemoryWorkspaceStore()
  const getKeys = vi.fn(async (): Promise<string[]> => ["file.md"])
  const view = createWorkspaceSourceView({
    name: "emptied-startup-mount",
    sources: { docs: custom({
      materialize: "startup",
      mount: "docs",
      getKeys,
      async getItem(key) { return { key, content: "generated" } },
    }) },
  }, store)
  await view.materializeSources()
  getKeys.mockResolvedValue([])
  await view.materializeSources()
  getKeys.mockRejectedValue(new Error("provider unavailable"))
  await expect(store.stat("docs")).resolves.toBeUndefined()
  await expect(view.exists("docs/file.md")).resolves.toBe(false)
  expect(getKeys).toHaveBeenCalledTimes(2)
})
