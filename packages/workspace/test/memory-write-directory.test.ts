import { afterEach, describe, expect, it } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { useWorkspace } from "../src/core/use.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

afterEach(() => resetWorkspaceRegistry())

describe("memory Workspace directory writes", () => {
  it.each([false, true])("preserves a directory through the public API (populated: %s)", async (populated) => {
    registerWorkspace("directory-write", defineWorkspace({ store: { provider: "memory" } }))
    const fs = useWorkspace("directory-write", { mode: "write" }).fs
    await fs.mkdir("notes")
    if (populated) await fs.writeFile("notes/keep.md", "keep")

    await expect(fs.writeFile("notes", "replacement")).rejects.toThrow("Cannot write a file over directory")

    await expect(fs.stat("notes")).resolves.toMatchObject({ type: "directory" })
    if (populated) await expect(fs.readFile("notes/keep.md")).resolves.toBe("keep")
    await fs.writeFile("notes/new.md", "new")
    await expect(fs.readFile("notes/new.md")).resolves.toBe("new")
  })

  it.each(["writeFile", "writeFileConditional"] as const)("preserves directory targets in Store %s", async (operation) => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("notes/keep.md", { path: "notes/keep.md", content: "keep" })

    for (const path of ["notes", ""]) {
      const file = { path, content: "replacement" }
      const write = operation === "writeFile"
        ? store.writeFile(path, file)
        : store.writeFileConditional!(path, file, null)
      await expect(write).rejects.toThrow("Cannot write a file over directory")
      await expect(store.stat(path)).resolves.toMatchObject({ type: "directory" })
    }
    await expect(store.readFile("notes/keep.md")).resolves.toMatchObject({ content: "keep" })
  })
})
