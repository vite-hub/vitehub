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


it.each(["build", "startup"] as const)("preserves unowned identical bytes after %s rollback owner retirement fails and the Store reopens", async (mode) => {
  const store = createMemoryWorkspaceStore()
  await store.writeFile("file.md", { path: "file.md", content: "original" })
  const setMeta = store.setMeta!.bind(store)
  let failCheckpoint = true
  store.setMeta = async (key, value) => {
    if (key.startsWith("workspace-file-owner:")) {
      if (value === null) throw new Error("owner retirement unavailable")
      await setMeta(key, value)
      if (failCheckpoint) {
        failCheckpoint = false
        throw new Error("checkpoint response lost")
      }
      return
    }
    await setMeta(key, value)
  }
  const definition: WorkspaceDefinition = { name: "rollback-reopen", sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "original" }] }),
  } }
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  if (mode === "build") await expect(sync(definition, store)).rejects.toThrow("checkpoint and rollback failed")
  else await expect(sync(definition, store)).resolves.toMatchObject({ sources: [{ error: 'Workspace file checkpoint and rollback failed for "file.md".' }] })
  const reopened: WorkspaceStore = {
    readFile: store.readFile.bind(store), writeFile: store.writeFile.bind(store),
    stat: store.stat.bind(store), list: store.list.bind(store), glob: store.glob.bind(store),
    mkdir: store.mkdir.bind(store), rm: store.rm.bind(store),
    snapshot: store.snapshot.bind(store), diff: store.diff.bind(store),
    getMeta: store.getMeta!.bind(store), setMeta,
  }
  await sync({ name: definition.name, sources: {} }, reopened)
  await expect(reopened.readFile("file.md")).resolves.toMatchObject({ content: "original" })
  await expect(readWorkspaceFileOwner(reopened, "file.md")).resolves.toBeUndefined()
})

it.each(["build", "startup"] as const)("restores user bytes when the %s checkpoint and removal marker both fail", async (mode) => {
  const store = createMemoryWorkspaceStore()
  await store.writeFile("file.md", { path: "file.md", content: "user content" })
  const setMeta = store.setMeta!.bind(store)
  let ownerWrites = 0
  store.setMeta = async (key, value) => {
    if (key.startsWith("workspace-file-owner:") && value !== null) {
      ownerWrites++
      throw new Error("ownership unavailable")
    }
    await setMeta(key, value)
  }
  const definition: WorkspaceDefinition = { name: "marker-outage", sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "generated" }] }),
  } }
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  if (mode === "build") await expect(sync(definition, store)).rejects.toThrow("checkpoint and rollback failed")
  else await expect(sync(definition, store)).resolves.toMatchObject({ sources: [{ error: 'Workspace file checkpoint and rollback failed for "file.md".' }] })
  expect(ownerWrites).toBe(2)
  await expect(store.readFile("file.md")).resolves.toMatchObject({ content: "user content" })
  await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toBeUndefined()
})

it.each(["build", "startup"] as const)("preserves another Workspace's identical bytes after %s rollback ownership restoration fails and the Store reopens", async (mode) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  const definition = (name: string): WorkspaceDefinition => ({ name, sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "original" }] }),
  } })
  await sync(definition("original"), store)
  const setMeta = store.setMeta!.bind(store)
  let writes = 0
  store.setMeta = async (key, value) => {
    if (key.startsWith("workspace-file-owner:")) {
      writes++
      if ((value as { workspace?: string } | null)?.workspace === "original") throw new Error("previous owner unavailable")
      await setMeta(key, value)
      if (writes === 1) throw new Error("checkpoint response lost")
      return
    }
    await setMeta(key, value)
  }
  if (mode === "build") await expect(sync(definition("replacement"), store)).rejects.toThrow("checkpoint and rollback failed")
  else await expect(sync(definition("replacement"), store)).resolves.toMatchObject({ sources: [{ error: 'Workspace file checkpoint and rollback failed for "file.md".' }] })
  const reopened: WorkspaceStore = {
    readFile: store.readFile.bind(store), writeFile: store.writeFile.bind(store),
    stat: store.stat.bind(store), list: store.list.bind(store), glob: store.glob.bind(store),
    mkdir: store.mkdir.bind(store), rm: store.rm.bind(store),
    snapshot: store.snapshot.bind(store), diff: store.diff.bind(store),
    getMeta: store.getMeta!.bind(store), setMeta,
  }
  await sync({ name: "replacement", sources: {} }, reopened)
  await expect(reopened.readFile("file.md")).resolves.toMatchObject({ content: "original" })
  await expect(readWorkspaceFileOwner(reopened, "file.md")).resolves.toBeUndefined()
})

it.each(["build", "startup"] as const)("rejects the failed %s owner after committed checkpoint, marker and retirement outages", async (mode) => {
  for (const revisions of [true, false]) {
    const store = createMemoryWorkspaceStore()
    const write = store.writeFile.bind(store)
    store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
    if (!revisions) {
      const stat = store.stat.bind(store)
      store.stat = async (path) => {
        const entry = await stat(path)
        return entry && { ...entry, revision: undefined }
      }
    }
    await store.writeFile("file.md", { path: "file.md", content: "original" })
    const setMeta = store.setMeta!.bind(store)
    let ownerWrites = 0
    store.setMeta = async (key, value) => {
      if (key.startsWith("workspace-file-owner:")) {
        ownerWrites++
        if (ownerWrites === 1) await setMeta(key, value)
        throw new Error("ownership unavailable")
      }
      await setMeta(key, value)
    }
    const definition: WorkspaceDefinition = { name: "combined-outage", sources: {
      docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "original" }] }),
    } }
    const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
    if (mode === "build") await expect(sync(definition, store)).rejects.toThrow("checkpoint and rollback failed")
    else await expect(sync(definition, store)).resolves.toMatchObject({ sources: [{ error: 'Workspace file checkpoint and rollback failed for "file.md".' }] })
    expect(ownerWrites).toBe(3)
    const reopened: WorkspaceStore = {
      readFile: store.readFile.bind(store), writeFile: store.writeFile.bind(store),
      stat: store.stat.bind(store), list: store.list.bind(store), glob: store.glob.bind(store),
      mkdir: store.mkdir.bind(store), rm: store.rm.bind(store),
      snapshot: store.snapshot.bind(store), diff: store.diff.bind(store),
      getMeta: store.getMeta!.bind(store), setMeta,
    }
    await expect(readWorkspaceFileOwner(reopened, "file.md")).resolves.toBeUndefined()
    await sync({ name: definition.name, sources: {} }, reopened)
    await sync({ name: definition.name, sources: {
      docs: custom({ materialize: mode, mount: "", files: [] }),
    } }, reopened)
    await expect(reopened.readFile("file.md")).resolves.toMatchObject({ content: "original" })
  }
})

it.each(["build", "startup"] as const)("keeps committed %s output when completion publication fails", async (mode) => {
  for (const committed of [true, false]) {
    const store = createMemoryWorkspaceStore()
    const write = store.writeFile.bind(store)
    store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
    await store.writeFile("file.md", { path: "file.md", content: "original" })
    const setMeta = store.setMeta!.bind(store)
    let publications = 0
    store.setMeta = async (key, value) => {
      if (key.startsWith("workspace-file-checkpoint:") && ++publications === 2) {
        if (committed) await setMeta(key, value)
        throw new Error("completion unavailable")
      }
      await setMeta(key, value)
    }
    const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
    const definition: WorkspaceDefinition = { name: "completion-outage", sources: {
      docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "generated" }] }),
    } }
    if (mode === "build") await expect(sync(definition, store)).rejects.toThrow("completion unavailable")
    else await expect(sync(definition, store)).resolves.toMatchObject({ sources: [{ error: "completion unavailable" }] })
    await expect(store.readFile("file.md")).resolves.toMatchObject({ content: "generated" })
    const owner = await readWorkspaceFileOwner(store, "file.md")
    if (committed) expect(owner).toMatchObject({ workspace: definition.name, source: "docs" })
    else expect(owner).toBeUndefined()
  }
})

it.each((["build", "startup"] as const).flatMap(mode =>
  ["write", "checkpoint"].map(failure => ({ mode, failure })),
))("preserves the previous $mode owner after $failure admission fails", async ({ mode, failure }) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  await store.writeFile("file.md", { path: "file.md", content: "seed" })
  const sync = mode === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  const definition: WorkspaceDefinition = { name: "previous-owner", sources: {
    docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "original" }] }),
  } }
  await sync(definition, store)
  const owner = await readWorkspaceFileOwner(store, "file.md")
  expect(owner).toMatchObject({ workspace: definition.name, source: "docs" })
  const setMeta = store.setMeta!.bind(store)
  if (failure === "write") {
    store.writeFile = async () => { throw new Error("write unavailable") }
  }
  else {
    store.setMeta = async (key, value) => {
      await setMeta(key, value)
      if (key.startsWith("workspace-file-checkpoint:")) throw new Error("checkpoint unavailable")
    }
  }
  // A retry must carry forward the last successful token, not the failed token.
  for (let attempt = 0; attempt < 2; attempt++) {
    const replacement: WorkspaceDefinition = { name: "failed-owner", sources: {
      docs: custom({ materialize: mode, mount: "", files: [{ path: "file.md", content: "replacement" }] }),
    } }
    if (mode === "build") await expect(sync(replacement, store)).rejects.toThrow(`${failure} unavailable`)
    else await expect(sync(replacement, store)).resolves.toMatchObject({ sources: [{ error: `${failure} unavailable` }] })
    await expect(readWorkspaceFileOwner(store, "file.md")).resolves.toEqual(owner)
    await expect(store.readFile("file.md")).resolves.toMatchObject({ content: "original" })
  }
  const reopened: WorkspaceStore = {
    readFile: store.readFile.bind(store), writeFile: write,
    stat: store.stat.bind(store), list: store.list.bind(store), glob: store.glob.bind(store),
    mkdir: store.mkdir.bind(store), rm: store.rm.bind(store),
    snapshot: store.snapshot.bind(store), diff: store.diff.bind(store),
    getMeta: store.getMeta!.bind(store), setMeta,
  }
  await expect(readWorkspaceFileOwner(reopened, "file.md")).resolves.toEqual(owner)
  await sync({ name: definition.name, sources: {} }, reopened)
  await expect(reopened.readFile("file.md")).resolves.toBeUndefined()
})
