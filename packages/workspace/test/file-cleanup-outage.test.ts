import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { readWorkspaceFileOwner, recordWorkspaceFileOwner, removeWorkspaceOwnedFile } from "../src/sources/file-ownership.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

const cases = ["build", "startup", "refresh"] as const

it.each(cases.flatMap(mode => [false, true].flatMap(volatile => [false, true].flatMap(deleted => (deleted ? [false, true] : [false]).map(recreated => ({ mode, volatile, deleted, recreated }))))))("recovers $mode cleanup after a provider outage, volatile=$volatile, deleted=$deleted, recreated=$recreated", async ({ mode, volatile, deleted, recreated }) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  if (volatile) {
    store.getMeta = undefined
    store.setMeta = undefined
  }
  const definition: WorkspaceDefinition = { name: "outage", sources: {
    source: custom({ materialize: mode === "build" ? "build" : "startup", mount: "", files: [{ path: "owned.md", content: "generated" }] }),
  } }
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  await sync(definition, store)
  const read = store.readFile.bind(store)
  const remove = store.rm.bind(store)
  const setMeta = store.setMeta?.bind(store)
  let outage = false
  store.readFile = async (path) => {
    if (outage) throw new Error("read unavailable")
    return read(path)
  }
  if (setMeta) store.setMeta = async (key, value) => {
    if (outage) throw new Error("metadata unavailable")
    await setMeta(key, value)
  }
  store.rm = async (path, options) => {
    if (deleted) await remove(path, options)
    outage = true
    throw new Error("remove unavailable")
  }
  const empty: WorkspaceDefinition = { name: definition.name, sources: mode === "refresh" ? {
    source: custom({ materialize: "startup", mount: "", files: [] }),
  } : {} }
  if (mode === "refresh" && volatile) {
    await expect(sync(empty, store)).resolves.toMatchObject({ sources: [{ error: "remove unavailable" }] })
  }
  else {
    await expect(sync(empty, store)).rejects.toThrow(mode === "refresh" ? "metadata unavailable" : "remove unavailable")
  }
  outage = false
  store.rm = remove
  if (recreated) await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  await sync(empty, store)
  if (recreated) await expect(store.readFile("owned.md")).resolves.toMatchObject({ content: "generated" })
  else await expect(store.readFile("owned.md")).resolves.toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "owned.md")).resolves.toBeUndefined()
  await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  await expect(readWorkspaceFileOwner(store, "owned.md")).resolves.toBeUndefined()
  await sync(empty, store)
  await expect(store.readFile("owned.md")).resolves.toMatchObject({ content: "generated" })
})


it("retires successful removal even when the metadata checkpoint fails", async () => {
  const store = createMemoryWorkspaceStore()
  await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  await recordWorkspaceFileOwner(store, "owned.md", { workspace: "outage", source: "source", digest: (await store.stat("owned.md"))?.digest })
  const setMeta = store.setMeta!.bind(store)
  store.setMeta = async (key, value) => {
    if (value === null) throw new Error("metadata unavailable")
    await setMeta(key, value)
  }
  await expect(removeWorkspaceOwnedFile(store, "owned.md")).rejects.toThrow("metadata unavailable")
  await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  store.setMeta = setMeta
  await expect(readWorkspaceFileOwner(store, "owned.md", true)).resolves.toBeUndefined()
  // A new facade with no volatile tombstone must also reject the durable marker.
  const reopened: WorkspaceStore = { ...store, readFile: store.readFile.bind(store), stat: store.stat.bind(store), getMeta: store.getMeta!.bind(store), setMeta }
  await expect(readWorkspaceFileOwner(reopened, "owned.md", true)).resolves.toBeUndefined()
  await expect(store.readFile("owned.md")).resolves.toMatchObject({ content: "generated" })
})

it("preserves ambiguous interrupted removal when the Store omits file revisions", async () => {
  const store = createMemoryWorkspaceStore()
  const stat = store.stat.bind(store)
  store.stat = async (path) => {
    const entry = await stat(path)
    return entry && { ...entry, revision: undefined }
  }
  await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  await recordWorkspaceFileOwner(store, "owned.md", { workspace: "outage", source: "source", digest: (await stat("owned.md"))?.digest })
  const remove = store.rm.bind(store)
  store.rm = async () => { throw new Error("remove unavailable") }
  await expect(removeWorkspaceOwnedFile(store, "owned.md")).rejects.toThrow("remove unavailable")
  await expect(readWorkspaceFileOwner(store, "owned.md", true)).rejects.toThrow("Cannot retry interrupted removal without a file revision")
  await expect(store.readFile("owned.md")).resolves.toMatchObject({ content: "generated" })
  await remove("owned.md")
  await expect(readWorkspaceFileOwner(store, "owned.md", true)).resolves.toBeUndefined()
})
