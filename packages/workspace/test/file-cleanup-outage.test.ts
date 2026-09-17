import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { readWorkspaceFileOwner } from "../src/sources/file-ownership.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

const cases = ["build", "startup", "refresh"] as const

it.each(cases.flatMap(mode => [false, true].flatMap(volatile => [false, true].map(deleted => ({ mode, volatile, deleted })))))("recovers $mode cleanup after a provider outage, volatile=$volatile, deleted=$deleted", async ({ mode, volatile, deleted }) => {
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
  await sync(empty, store)
  await expect(store.readFile("owned.md")).resolves.toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "owned.md")).resolves.toBeUndefined()
  await store.writeFile("owned.md", { path: "owned.md", content: "generated" })
  await expect(readWorkspaceFileOwner(store, "owned.md")).resolves.toBeUndefined()
  await sync(empty, store)
  await expect(store.readFile("owned.md")).resolves.toMatchObject({ content: "generated" })
})
