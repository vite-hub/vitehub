import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { readWorkspaceFileOwner } from "../src/sources/file-ownership.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { contentStreamToBytes, sha256 } from "../src/core/path.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

it.each(["build", "startup"] as const)("preserves an identical replacement after %s rollback deletes then fails", async (mode) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  const setMeta = store.setMeta!.bind(store)
  let fail = true
  store.setMeta = async (key, value) => {
    if (fail && key.startsWith("workspace-file-owner:")) {
      fail = false
      throw new Error("ownership unavailable")
    }
    await setMeta(key, value)
  }
  const remove = store.rm.bind(store)
  store.rm = async (path, options) => {
    await remove(path, options)
    throw new Error("rollback failed after deletion")
  }
  const definition: WorkspaceDefinition = { name: "rollback-replacement", sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "generated" }] }),
  } }
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  if (mode === "build") await expect(sync(definition, store)).rejects.toThrow("checkpoint and rollback failed")
  else await expect(sync(definition, store)).resolves.toMatchObject({ sources: [{ error: 'Workspace file checkpoint and rollback failed for "file.md".' }] })
  await expect(store.readFile("file.md")).resolves.toBeUndefined()
  await store.writeFile("file.md", { path: "file.md", content: "generated" })
  store.rm = remove
  await sync({ name: definition.name, sources: {} }, store)
  await expect(store.readFile("file.md")).resolves.toMatchObject({ content: "generated" })
  await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toBeUndefined()
})

it.each(["build", "startup"] as const)("rolls back a committed %s file when ownership persistence fails", async (mode) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  const setMeta = store.setMeta!.bind(store)
  let fail = true
  store.setMeta = async (key, value) => {
    if (fail && key.startsWith("workspace-file-owner:")) {
      fail = false
      throw new Error("ownership unavailable")
    }
    await setMeta(key, value)
  }
  const definition: WorkspaceDefinition = { name: "checkpoint", sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "generated" }] }),
  } }
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  if (mode === "build") await expect(sync(definition, store)).rejects.toThrow("ownership unavailable")
  else await expect(sync(definition, store)).resolves.toMatchObject({ sources: [{ error: "ownership unavailable" }] })
  await expect(store.readFile("file.md")).resolves.toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toBeUndefined()
  await sync({ name: definition.name, sources: {} }, store)
  await expect(store.readFile("file.md")).resolves.toBeUndefined()
})

it.each(["build", "startup"] as const)("retains %s cleanup evidence when metadata and rollback both fail", async (mode) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  const setMeta = store.setMeta!.bind(store)
  const remove = store.rm.bind(store)
  let outage = false
  store.writeFile = async (path, file) => {
    await write(path, { ...file, metadata: undefined })
    outage = true
  }
  store.setMeta = async (key, value) => {
    if (outage) throw new Error("metadata unavailable")
    await setMeta(key, value)
  }
  store.rm = async (path, options) => {
    if (outage) throw new Error("rollback unavailable")
    await remove(path, options)
  }
  const definition: WorkspaceDefinition = { name: "outage", sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "generated" }] }),
  } }
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  await expect(sync(definition, store)).rejects.toThrow(mode === "build" ? "checkpoint and rollback failed" : "metadata unavailable")
  outage = false
  await sync({ name: definition.name, sources: {} }, store)
  await expect(store.readFile("file.md")).resolves.toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toBeUndefined()
})

it.each(["writeFileConditional", "writeFileStream"] as const)("rolls back build output from %s after checkpoint failure", async (method) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  store.writeFileStream = async (path, file) => {
    const content = await contentStreamToBytes(file.content)
    await store.writeFile(path, { ...file, content })
    return { path, type: "file", digest: await sha256(content), size: content.byteLength }
  }
  const setMeta = store.setMeta!.bind(store)
  let fail = true
  store.setMeta = async (key, value) => {
    if (fail && key.startsWith("workspace-file-owner:")) {
      fail = false
      throw new Error("ownership unavailable")
    }
    await setMeta(key, value)
  }
  const definition: WorkspaceDefinition = { name: "write-forms", sources: {
    docs: custom({ materialize: "build", mount: "", files: [] }),
  }, loaders: [{ name: "output", async load(ctx) {
    if (method === "writeFileConditional") await ctx.store.writeFileConditional!("file.md", { path: "file.md", content: "generated" }, null)
    else await ctx.store.writeFileStream!("file.md", { path: "file.md", content: (async function* () { yield new TextEncoder().encode("generated") })() })
  } }] }
  await expect(syncWorkspaceDefinition(definition, store)).rejects.toThrow("ownership unavailable")
  await expect(store.readFile("file.md")).resolves.toBeUndefined()
  await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toBeUndefined()
})

it.each(["build", "startup"] as const)("restores existing bytes and ownership after a %s checkpoint failure", async (mode) => {
  const store = createMemoryWorkspaceStore()
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  const definition = (name: string, content: string): WorkspaceDefinition => ({ name, sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content }] }),
  } })
  await sync(definition("original", "original content"), store)
  const owner = await readWorkspaceFileOwner(store, "file.md")
  const setMeta = store.setMeta!.bind(store)
  let fail = true
  store.setMeta = async (key, value) => {
    if (fail && key.startsWith("workspace-file-owner:")) {
      fail = false
      throw new Error("ownership unavailable")
    }
    await setMeta(key, value)
  }
  if (mode === "build") await expect(sync(definition("replacement", "replacement content"), store)).rejects.toThrow("ownership unavailable")
  else await expect(sync(definition("replacement", "replacement content"), store)).resolves.toMatchObject({ sources: [{ error: "ownership unavailable" }] })
  await expect(store.readFile("file.md")).resolves.toMatchObject({ content: "original content" })
  await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toEqual(owner)
  await sync({ name: "replacement", sources: {} }, store)
  await expect(store.readFile("file.md")).resolves.toMatchObject({ content: "original content" })
})
