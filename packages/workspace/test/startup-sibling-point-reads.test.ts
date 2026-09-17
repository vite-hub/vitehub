import { describe, expect, it } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

function createSiblingWorkspace(reuseStartupSnapshots = false) {
  const store = createMemoryWorkspaceStore()
  const definition = {
    name: "startup-sibling-point-reads",
    sources: {
      first: custom({ materialize: "startup", mount: "docs", files: [
        { path: "first.md", content: "first" },
        { path: "shared.md", content: "first wins" },
      ] }),
      second: custom({ materialize: "startup", mount: "docs", files: [
        { path: "second.md", content: "second" },
        { path: "shared.md", content: "second loses" },
      ] }),
    },
  }
  return { store, view: createWorkspaceSourceView(definition, store, { reuseStartupSnapshots }) }
}

describe("startup Sources sharing a mount", () => {
  it.each(["readFile", "stat", "exists"] as const)("materializes sibling files for a fresh %s", async (operation) => {
    const { store, view } = createSiblingWorkspace()
    if (operation === "readFile") await expect(view.readFile("docs/second.md", { encoding: "utf8" })).resolves.toBe("second")
    if (operation === "stat") await expect(view.stat("docs/second.md")).resolves.toMatchObject({ type: "file" })
    if (operation === "exists") await expect(view.exists("docs/second.md")).resolves.toBe(true)
    await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ content: "first wins" })
  })

  it.each([false, true])("recovers a missing sibling file with snapshot reuse %s", async (reuseStartupSnapshots) => {
    const { store, view } = createSiblingWorkspace(reuseStartupSnapshots)
    await view.materializeSources()
    await store.rm("docs/second.md")
    await expect(view.readFile("docs/second.md", { encoding: "utf8" })).resolves.toBe("second")
    await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ content: "first wins" })
    await expect(view.readFile("docs/shared.md", { encoding: "utf8" })).resolves.toBe("first wins")
  })

  it("preserves the deeper mount when a point read initializes overlapping Sources", async () => {
    const store = createMemoryWorkspaceStore()
    const view = createWorkspaceSourceView({ name: "nested-point-read", sources: {
      ancestor: custom({ materialize: "startup", mount: "docs", files: [
        { path: "nested/only-ancestor.md", content: "ancestor" },
        { path: "nested/shared.md", content: "ancestor loses" },
      ] }),
      nested: custom({ materialize: "startup", mount: "docs/nested", files: [
        { path: "shared.md", content: "nested wins" },
      ] }),
    } }, store)
    await expect(view.readFile("docs/nested/only-ancestor.md", { encoding: "utf8" })).resolves.toBe("ancestor")
    await expect(store.readFile("docs/nested/shared.md")).resolves.toMatchObject({ content: "nested wins" })
  })

  it("preserves a directory that replaces a sibling file", async () => {
    const { store, view } = createSiblingWorkspace()
    await view.materializeSources()
    await store.rm("docs/second.md")
    await store.mkdir("docs/second.md")
    await expect(view.exists("docs/second.md")).resolves.toBe(false)
    await expect(store.stat("docs/second.md")).resolves.toMatchObject({ type: "directory" })
  })
})
