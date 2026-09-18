import { afterEach, expect, it, vi } from "vitest"
import { custom, useWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { invalidateSourceSnapshot } from "../src/sources/materialization.ts"

afterEach(() => resetWorkspaceRegistry())

it.each(["", "docs"])("reuses overlapping startup snapshots at '%s' without available providers", async (mount) => {
  const firstKeys = vi.fn(async () => ["shared.md"])
  const secondKeys = vi.fn(async () => ["shared.md"])
  const definition = {
    name: "overlapping-inspection",
    store: { provider: "memory" as const },
    sources: {
      first: custom({ materialize: "startup", mount, getKeys: firstKeys, async getItem(key) { return { key, content: "first" } } }),
      second: custom({ materialize: "startup", mount, getKeys: secondKeys, async getItem(key) { return { key, content: "second" } } }),
    },
  }
  const initial = useWorkspace(definition.name, { definition })
  await initial.fs.list("", { recursive: true })
  const path = mount ? `${mount}/shared.md` : "shared.md"
  const content = await initial.fs.readFile(path)
  const firstCalls = firstKeys.mock.calls.length
  const secondCalls = secondKeys.mock.calls.length
  firstKeys.mockRejectedValue(new Error("provider unavailable"))
  secondKeys.mockRejectedValue(new Error("provider unavailable"))

  const inspection = useWorkspace(definition.name, { definition, mode: "read", refresh: false })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(inspection.fs.list("", { recursive: true })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path, type: "file" }),
    ]))
    await expect(inspection.fs.readFile(path)).resolves.toEqual(content)
  }
  expect(firstKeys).toHaveBeenCalledTimes(firstCalls)
  expect(secondKeys).toHaveBeenCalledTimes(secondCalls)
})

it.each(["snapshot", "owner", "content"])("refreshes an overlapping snapshot when the winning %s is invalid", async (invalid) => {
  const firstKeys = vi.fn(async () => ["shared.md"])
  const definition = {
    name: "invalid-overlapping-inspection",
    sources: {
      first: custom({ materialize: "startup", mount: "", getKeys: firstKeys, async getItem(key) { return { key, content: "first" } } }),
      second: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "second" }] }),
    },
  }
  const store = createMemoryWorkspaceStore()
  const initial = createWorkspaceSourceView(definition, store)
  await initial.materializeSources({ sources: ["first"] })
  await initial.materializeSources({ sources: ["second"] })
  if (invalid === "snapshot") await invalidateSourceSnapshot(store, definition.name, "second")
  if (invalid === "owner") await store.setMeta!("workspace-file-owner:shared.md", null)
  if (invalid === "content") {
    const file = await store.readFile("shared.md")
    await store.writeFile("shared.md", { ...file!, content: "changed" })
  }
  await createWorkspaceSourceView({ ...definition }, store, { reuseStartupSnapshots: true }).list("", { recursive: true })
  expect(firstKeys).toHaveBeenCalledTimes(2)
})
