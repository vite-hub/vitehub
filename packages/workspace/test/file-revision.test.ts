import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { readWorkspaceFileOwner, recordWorkspaceFileOwner, removeWorkspaceOwnedFile } from "../src/sources/file-ownership.ts"

it.each(["memory", "local"] as const)("%s revisions distinguish identical writes and recreations", async (provider) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-revision-"))
  try {
    const store = provider === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    const file = { path: "owned.md", content: "generated" }
    await store.writeFile(file.path, file)
    const first = await store.stat(file.path)
    expect(first?.revision).toBeTypeOf("string")
    expect((await store.stat(file.path))?.revision).toBe(first?.revision)
    if (provider === "local") await writeFile(join(root, file.path), file.content)
    else await store.writeFile(file.path, file)
    const second = await store.stat(file.path)
    expect(second?.revision).not.toBe(first?.revision)
    await recordWorkspaceFileOwner(store, file.path, { workspace: "outage", source: "source", digest: second?.digest })
    const remove = store.rm.bind(store)
    store.rm = async (path, options) => {
      await remove(path, options)
      throw new Error("lost response")
    }
    await expect(removeWorkspaceOwnedFile(store, file.path)).rejects.toThrow("lost response")
    if (provider === "local") await writeFile(join(root, file.path), file.content)
    else await store.writeFile(file.path, file)
    expect((await store.stat(file.path))?.revision).not.toBe(second?.revision)
    await expect(readWorkspaceFileOwner(store, file.path, true)).resolves.toBeUndefined()
    const remaining = await store.readFile(file.path)
    expect(remaining).toBeDefined()
    expect(typeof remaining?.content === "string" ? remaining.content : new TextDecoder().decode(remaining?.content)).toBe("generated")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})


it.each(["memory", "local"] as const)("%s retires interrupted file removal when a directory replaces the file", async (provider) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-directory-replacement-"))
  try {
    const store = provider === "local" ? createLocalWorkspaceStore(root) : createMemoryWorkspaceStore()
    await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
    await recordWorkspaceFileOwner(store, "owned.md", { workspace: "outage", source: "source", digest: (await store.stat("owned.md"))?.digest })
    const setMeta = store.setMeta!.bind(store)
    store.setMeta = async (key, value) => {
      if (value === null) throw new Error("metadata unavailable")
      await setMeta(key, value)
    }
    await expect(removeWorkspaceOwnedFile(store, "owned.md")).rejects.toThrow("metadata unavailable")
    await store.mkdir("owned.md")
    const reopened = provider === "local" ? createLocalWorkspaceStore(root) : { ...store, stat: store.stat.bind(store), readFile: store.readFile.bind(store), getMeta: store.getMeta!.bind(store), setMeta }
    await expect(readWorkspaceFileOwner(reopened, "owned.md", true)).resolves.toBeUndefined()
    await expect(reopened.getMeta!("workspace-file-owner:owned.md")).resolves.toBeNull()
    await expect(reopened.stat("owned.md")).resolves.toMatchObject({ type: "directory" })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
