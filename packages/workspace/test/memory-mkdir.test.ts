import { describe, expect, it } from "vitest"

import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

describe("memory Workspace mkdir", () => {
  it("does not replace an existing file", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("notes", { path: "notes", content: "keep" })

    await expect(store.mkdir("notes")).rejects.toThrow("Workspace path already exists")
    await expect(store.readFile("notes")).resolves.toMatchObject({ content: "keep" })
  })

  it("honors recursive false", async () => {
    const store = createMemoryWorkspaceStore()

    await expect(store.mkdir("nested/notes", { recursive: false })).rejects.toThrow("Workspace parent does not exist")
    await store.mkdir("nested", { recursive: false })
    await expect(store.mkdir("nested", { recursive: false })).rejects.toThrow("Workspace path already exists")
    await store.mkdir("nested/notes", { recursive: false })
  })
})
