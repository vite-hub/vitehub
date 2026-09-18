import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import { contentStreamChunks } from "../src/core/path.ts"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { registerWorkspace, useWorkspace } from "../src/runtime.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

it.each([false, true])("invalidates startup snapshots after durable build overwrites, explicit=%s", async (explicit) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  const name = `build-overwrite-${crypto.randomUUID()}`
  const definition: WorkspaceDefinition = {
    name,
    sources: {
      build: custom({ materialize: "build", mount: "", files: [{ path: "docs/shared.md", content: "build" }] }),
      startup: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "startup" }] }),
    },
    loaders: explicit ? [{ name: "derived", async load(ctx) {
      await ctx.store.writeFile("docs/shared.md", { path: "docs/shared.md", content: "build" })
    } }] : undefined,
  }
  const workspace = createWorkspaceSourceView(definition, store)
  await expect(workspace.readFile("docs/shared.md")).resolves.toBe("startup")
  await syncWorkspaceDefinition(definition, store)
  await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ content: "build" })
  await expect(store.getMeta!(sourceSnapshotMetaKey(name, "startup"))).resolves.toMatchObject({ status: "updating" })
  await expect(workspace.readFile("docs/shared.md")).resolves.toBe("startup")
})

it.each([false, true])("preserves external replacements after durable build ownership is recorded, explicit=%s", async (explicit) => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  const name = `build-overwrite-${crypto.randomUUID()}`
  const definition: WorkspaceDefinition = {
    name,
    sources: {
      build: custom({ materialize: "build", mount: "", files: [{ path: "docs/shared.md", content: "build" }] }),
      startup: custom({ materialize: "startup", mount: "docs", files: [{ path: "shared.md", content: "startup" }] }),
    },
    loaders: explicit ? [{ name: "derived", async load(ctx) {
      await ctx.store.writeFile("docs/shared.md", { path: "docs/shared.md", content: "build" })
    } }] : undefined,
  }
  const workspace = createWorkspaceSourceView(definition, store)
  await expect(workspace.readFile("docs/shared.md")).resolves.toBe("startup")
  const setMeta = store.setMeta!.bind(store)
  store.setMeta = async (key, value) => {
    await setMeta(key, value)
    if (key === `workspace:${encodeURIComponent(name)}:build-files`) {
      await store.writeFile("docs/shared.md", { path: "docs/shared.md", content: "external replacement" })
    }
  }
  await syncWorkspaceDefinition(definition, store)
  await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ content: "external replacement" })
  await expect(store.getMeta!(sourceSnapshotMetaKey(name, "startup"))).resolves.toMatchObject({ status: "ready" })
  await expect(workspace.readFile("docs/shared.md")).resolves.toBe("external replacement")
})

for (const mount of ["", "docs"]) {
  for (const explicit of [false, true]) {
    it(`isolates shared-Store build cleanup at '${mount}' with explicit loader=${explicit}`, async () => {
      const store = createMemoryWorkspaceStore()
      const path = (file: string) => [mount, file].filter(Boolean).join("/")
      const definition = (name: string): WorkspaceDefinition => ({
        name,
        sources: { docs: custom({ materialize: "build", mount, files: [
          { path: `${name}.md`, content: name },
          { path: "shared.md", content: name },
        ] }) },
        loaders: explicit ? [{ name: "derived", async load(ctx) {
          for (const file of [`${name}.md`, "shared.md"]) {
            await ctx.store.writeFile(path(file), { path: path(file), content: name })
          }
        } }] : undefined,
      })
      await syncWorkspaceDefinition(definition("first"), store)
      await syncWorkspaceDefinition(definition("second"), store)
      await expect(store.readFile(path("first.md"))).resolves.toMatchObject({ content: "first" })
      await expect(store.readFile(path("shared.md"))).resolves.toMatchObject({ content: "second" })

      await syncWorkspaceDefinition({ name: "first", sources: {} }, store)
      await expect(store.stat(path("first.md"))).resolves.toBeUndefined()
      await expect(store.readFile(path("second.md"))).resolves.toMatchObject({ content: "second" })
      await expect(store.readFile(path("shared.md"))).resolves.toMatchObject({ content: "second" })

      await syncWorkspaceDefinition({ name: "second", sources: {} }, store)
      await expect(store.stat(path("second.md"))).resolves.toBeUndefined()
      await expect(store.stat(path("shared.md"))).resolves.toBeUndefined()
      if (mount) await expect(store.stat(mount)).resolves.toBeUndefined()
    })
  }
}

it.each(["", "docs"])("preserves unowned legacy build files at '%s'", async (mount) => {
  const store = createMemoryWorkspaceStore()
  const path = [mount, "legacy.md"].filter(Boolean).join("/")
  await syncWorkspaceDefinition({ name: "first", sources: {
    docs: custom({ materialize: "build", mount, files: [{ path: "legacy.md", content: "legacy" }] }),
  } }, store)
  await store.writeFile(path, { path, content: "legacy", metadata: { source: "docs", workspaceBuildSource: "docs" } })
  await syncWorkspaceDefinition({ name: "first", sources: {} }, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "legacy" })
})

for (const mount of ["", "docs"]) {
  for (const omitState of [false, true]) {
    it.each([false, true].flatMap(explicit => [false, true].map(omitListMetadata => ({ explicit, omitListMetadata }))))(`cleans stale build files at '${mount}' with omitted state=${omitState}, explicit=$explicit, omitted list metadata=$omitListMetadata`, async ({ explicit, omitListMetadata }) => {
      const store: WorkspaceStore = createMemoryWorkspaceStore()
      const list = store.list.bind(store)
      if (omitListMetadata) store.list = async (path, options) => (await list(path, options)).map(entry => ({ ...entry, metadata: undefined }))
      if (omitState) {
        store.getMeta = undefined
        store.setMeta = undefined
      }
      const path = (file: string) => [mount, file].filter(Boolean).join("/")
      let files = ["old.md", "current.md"]
      const definition = (): WorkspaceDefinition => ({
        name: "custom-store",
        sources: { docs: custom({ materialize: "build", mount, files: files.map(file => ({ path: file, content: file })) }) },
        loaders: explicit ? [{ name: "derived", async load(ctx) {
          for (const file of files) await ctx.store.writeFile(path(file), { path: path(file), content: file })
        } }] : undefined,
      })
      await syncWorkspaceDefinition(definition(), store)
      await store.writeFile(path("user.md"), { path: path("user.md"), content: "user" })
      await store.writeFile(path("other.md"), { path: path("other.md"), content: "other", metadata: { source: "docs", workspaceSourceOwner: "other" } })
      files = ["current.md"]
      await syncWorkspaceDefinition(definition(), store)
      await expect(store.readFile(path("old.md"))).resolves.toBeUndefined()
      await expect(store.readFile(path("current.md"))).resolves.toMatchObject({ content: "current.md" })
      await expect(store.readFile(path("user.md"))).resolves.toMatchObject({ content: "user" })
      await expect(store.readFile(path("other.md"))).resolves.toMatchObject({ content: "other" })
    })
  }
}

for (const mount of ["", "docs"]) {
  it.each([false, true])(`cleans durable build ownership after reopening a metadata-dropping Store at '${mount}', explicit=%s`, async (explicit) => {
    const backing = createMemoryWorkspaceStore()
    const open = (): WorkspaceStore => new Proxy(backing, {
      get(target, property) {
        if (property === "writeFile") return async (path: string, file: Parameters<WorkspaceStore["writeFile"]>[1]) => {
          await target.writeFile(path, { ...file, metadata: undefined })
        }
        if (property === "list") return async (path: string, options: Parameters<WorkspaceStore["list"]>[1]) => {
          return (await target.list(path, options)).map(entry => ({ ...entry, digest: explicit ? "provider-specific-digest" : undefined }))
        }
        if (property === "readFile") return async (path: string) => {
          const file = await target.readFile(path)
          return file && { ...file, metadata: { mode: "100644" } }
        }
        return Reflect.get(target, property, target)?.bind(target)
      },
    })
    const path = (file: string) => [mount, file].filter(Boolean).join("/")
    const definition = (name: string, files: string[]): WorkspaceDefinition => ({
      name,
      sources: { docs: custom({ materialize: "build", mount, files: files.map(file => ({ path: file, content: file })) }) },
      loaders: explicit ? [{ name: "derived", async load(ctx) {
        for (const file of files) await ctx.store.writeFile(path(file), { path: path(file), content: file })
      } }] : undefined,
    })
    await syncWorkspaceDefinition(definition("first", ["old.md", "shared.md", "edited.md", "current.md"]), open())
    await syncWorkspaceDefinition(definition("second", ["shared.md", "second.md"]), open())
    await open().writeFile(path("edited.md"), { path: path("edited.md"), content: "external edit" })
    await open().writeFile(path("user.md"), { path: path("user.md"), content: "user" })
    await syncWorkspaceDefinition(definition("first", ["current.md"]), open())
    await expect(open().readFile(path("old.md"))).resolves.toBeUndefined()
    await expect(open().readFile(path("current.md"))).resolves.toMatchObject({ content: "current.md" })
    await expect(open().readFile(path("shared.md"))).resolves.toMatchObject({ content: "shared.md" })
    await expect(open().readFile(path("second.md"))).resolves.toMatchObject({ content: "second.md" })
    await expect(open().readFile(path("edited.md"))).resolves.toMatchObject({ content: "external edit" })
    await expect(open().readFile(path("user.md"))).resolves.toMatchObject({ content: "user" })
    await syncWorkspaceDefinition({ name: "first", sources: {} }, open())
    await expect(open().readFile(path("current.md"))).resolves.toBeUndefined()
    await expect(open().readFile(path("shared.md"))).resolves.toBeDefined()
    await syncWorkspaceDefinition({ name: "second", sources: {} }, open())
    await expect(open().readFile(path("second.md"))).resolves.toBeUndefined()
    await expect(open().readFile(path("shared.md"))).resolves.toBeUndefined()
  })
}


it("preserves a same-byte startup overwrite when the Store drops file metadata", async () => {
  const store = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  await syncWorkspaceDefinition({ name: "build-owner", sources: {
    docs: custom({ materialize: "build", mount: "", files: [{ path: "shared.md", content: "same" }] }),
  } }, store)
  const name = `startup-owner-${crypto.randomUUID()}`
  registerWorkspace(name, { store, sources: {
    docs: custom({ materialize: "startup", mount: "", files: [{ path: "shared.md", content: "same" }] }),
  } })
  await expect(useWorkspace(name).fs.readFile("shared.md", { encoding: "utf8" })).resolves.toBe("same")
  await syncWorkspaceDefinition({ name: "build-owner", sources: {} }, store)
  await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "same" })
})


it.each(["", "docs"])("cleans volatile build output at '%s' without metadata APIs", async (mount) => {
  const store = createMemoryWorkspaceStore()
  store.getMeta = undefined
  store.setMeta = undefined
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  const path = (file: string) => [mount, file].filter(Boolean).join("/")
  const definition = (files: string[]): WorkspaceDefinition => ({
    name: "volatile-build",
    sources: { docs: custom({ materialize: "build", mount, files: files.map(path => ({ path, content: path })) }) },
  })
  await syncWorkspaceDefinition(definition(["stale.md", "edited.md", "current.md"]), store)
  await store.writeFile(path("edited.md"), { path: path("edited.md"), content: "user edit" })
  await syncWorkspaceDefinition(definition(["current.md"]), store)
  await expect(store.stat(path("stale.md"))).resolves.toBeUndefined()
  await expect(store.readFile(path("edited.md"))).resolves.toMatchObject({ content: "user edit" })
  await syncWorkspaceDefinition({ name: "volatile-build", sources: {} }, store)
  await expect(store.stat(path("current.md"))).resolves.toBeUndefined()
})

it.each([false, true])("prunes owned build directories and preserves existing directories, remove=%s", async (remove) => {
  const store = createMemoryWorkspaceStore()
  await store.mkdir("docs/existing", { recursive: true })
  const definition: WorkspaceDefinition = {
    name: "build-directories",
    sources: { docs: custom({ materialize: "build", mount: "docs", files: [
      { path: "existing/file.md", content: "generated" },
      { path: "owned/deep/file.md", content: "generated" },
      { path: "retained/file.md", content: "generated" },
    ] }) },
  }
  await syncWorkspaceDefinition(definition, store)
  await store.writeFile("docs/retained/user.md", { path: "docs/retained/user.md", content: "user" })
  await syncWorkspaceDefinition({ ...definition, sources: remove ? {} : {
    docs: custom({ materialize: "build", mount: "docs", files: [] }),
  } }, store)
  await expect(store.stat("docs/owned")).resolves.toBeUndefined()
  await expect(store.stat("docs/existing")).resolves.toMatchObject({ type: "directory" })
  await expect(store.readFile("docs/retained/user.md")).resolves.toMatchObject({ content: "user" })
})

it("prunes a removed build mount and its created ancestors", async () => {
  const store = createMemoryWorkspaceStore()
  await syncWorkspaceDefinition({ name: "build-mount", sources: {
    docs: custom({ materialize: "build", mount: "parent/docs", files: [{ path: "nested/file.md", content: "generated" }] }),
  } }, store)
  await syncWorkspaceDefinition({ name: "build-mount", sources: {} }, store)
  await expect(store.stat("parent")).resolves.toBeUndefined()
})

it.each(["writeFile", "writeFileConditional", "writeFileStream"] as const)("checkpoints an accepted %s after cancellation", async (method) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  const controller = new AbortController()
  const commit = async (path: string, file: Parameters<WorkspaceStore["writeFile"]>[1]) => {
    await write(path, { ...file, metadata: undefined })
    controller.abort(new Error("cancelled after write"))
  }
  store.writeFile = commit
  store.writeFileConditional = commit
  store.writeFileStream = async (path, file) => {
    for await (const chunk of contentStreamChunks(file.content)) {
      await commit(path, { path, content: chunk })
    }
    return { path, type: "file", digest: "unused", size: 9 }
  }
  const definition: WorkspaceDefinition = {
    name: "cancelled-build",
    sources: { docs: custom({ materialize: "build", mount: "docs", files: [] }) },
    loaders: [{ name: "write", async load(ctx) {
      const file = { path: "docs/file.md", content: "generated" }
      if (method === "writeFileStream") {
        await ctx.store.writeFileStream!(file.path, { ...file, content: (async function* () { yield new TextEncoder().encode(file.content) })() })
      }
      else if (method === "writeFileConditional") await ctx.store.writeFileConditional!(file.path, file, null)
      else await ctx.store.writeFile(file.path, file)
    } }],
  }
  await expect(syncWorkspaceDefinition(definition, store, controller.signal)).rejects.toThrow("cancelled after write")
  await expect(store.readFile("docs/file.md")).resolves.toBeDefined()
  await syncWorkspaceDefinition({ name: definition.name, sources: {} }, store)
  await expect(store.stat("docs/file.md")).resolves.toBeUndefined()
})

it.each([false, true])("shares empty build mount ownership between Workspaces, volatile=%s", async (volatile) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  if (volatile) {
    store.getMeta = undefined
    store.setMeta = undefined
  }
  const definition = (name: string): WorkspaceDefinition => ({ name, sources: {
    docs: custom({ materialize: "build", mount: "parent/docs", files: [] }),
  } })
  await syncWorkspaceDefinition(definition("first"), store)
  await syncWorkspaceDefinition(definition("second"), store)
  await syncWorkspaceDefinition({ name: "first", sources: {} }, store)
  await expect(store.stat("parent/docs")).resolves.toMatchObject({ type: "directory" })
  await syncWorkspaceDefinition({ name: "second", sources: {} }, store)
  await expect(store.stat("parent")).resolves.toBeUndefined()
})

it.each([
  { volatile: false, removed: "first", retained: "second" },
  { volatile: false, removed: "second", retained: "first" },
  { volatile: true, removed: "first", retained: "second" },
  { volatile: true, removed: "second", retained: "first" },
])("shares concurrently registered empty build mount ownership between Workspaces, volatile=$volatile, removed=$removed", async ({ volatile, removed, retained }) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  if (volatile) {
    store.getMeta = undefined
    store.setMeta = undefined
  }
  const stat = store.stat.bind(store)
  store.stat = async (path) => {
    const result = await stat(path)
    // Yield like an asynchronous provider so both syncs can read before either claims.
    await setImmediate()
    return result
  }
  const definition = (name: string): WorkspaceDefinition => ({ name, sources: {
    docs: custom({ materialize: "build", mount: "parent/docs", files: [] }),
  } })
  await Promise.all([
    syncWorkspaceDefinition(definition("first"), store, new AbortController().signal),
    syncWorkspaceDefinition(definition("second"), store, new AbortController().signal),
  ])
  await syncWorkspaceDefinition({ name: removed, sources: {} }, store)
  await expect(store.stat("parent/docs")).resolves.toMatchObject({ type: "directory" })
  await syncWorkspaceDefinition({ name: retained, sources: {} }, store)
  await expect(store.stat("parent")).resolves.toBeUndefined()
})

it.each(["writeFile", "writeFileConditional", "writeFileStream"] as const)("does not claim directories after failed %s", async (method) => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  const failure = async () => { throw new Error("write failed") }
  store[method] = failure
  const definition: WorkspaceDefinition = {
    name: "failed-build",
    sources: { docs: custom({ materialize: "build", mount: "", files: [] }) },
    loaders: [{ name: "fail", async load(ctx) {
      const file = { path: "user/deep/file.md", content: "generated" }
      if (method === "writeFileStream") await ctx.store.writeFileStream!(file.path, { ...file, content: (async function* () { yield new TextEncoder().encode(file.content) })() })
      else if (method === "writeFileConditional") await ctx.store.writeFileConditional!(file.path, file, null)
      else await ctx.store.writeFile(file.path, file)
    } }],
  }
  await expect(syncWorkspaceDefinition(definition, store)).rejects.toThrow("write failed")
  await store.mkdir("user/deep", { recursive: true })
  await syncWorkspaceDefinition({ name: definition.name, sources: {} }, store)
  await expect(store.stat("user/deep")).resolves.toMatchObject({ type: "directory" })
})

it("does not claim directories after failed mkdir", async () => {
  const store = createMemoryWorkspaceStore()
  const mkdir = store.mkdir.bind(store)
  store.mkdir = async () => { throw new Error("mkdir failed") }
  await expect(syncWorkspaceDefinition({ name: "failed-mount", sources: {
    docs: custom({ materialize: "build", mount: "user/docs", files: [] }),
  } }, store)).rejects.toThrow("mkdir failed")
  store.mkdir = mkdir
  await store.mkdir("user/docs", { recursive: true })
  await syncWorkspaceDefinition({ name: "failed-mount", sources: {} }, store)
  await expect(store.stat("user/docs")).resolves.toMatchObject({ type: "directory" })
})

it("checkpoints an accepted mkdir after cancellation", async () => {
  const store = createMemoryWorkspaceStore()
  const mkdir = store.mkdir.bind(store)
  const controller = new AbortController()
  store.mkdir = async (path, options) => {
    await mkdir(path, options)
    controller.abort(new Error("cancelled after mkdir"))
  }
  await expect(syncWorkspaceDefinition({ name: "cancelled-mount", sources: {
    docs: custom({ materialize: "build", mount: "parent/docs", files: [] }),
  } }, store, controller.signal)).rejects.toThrow("cancelled after mkdir")
  await syncWorkspaceDefinition({ name: "cancelled-mount", sources: {} }, store)
  await expect(store.stat("parent")).resolves.toBeUndefined()
})

it("retains directory cleanup authority after a removal failure", async () => {
  const store = createMemoryWorkspaceStore()
  const remove = store.removeEmptyDirectory!.bind(store)
  await syncWorkspaceDefinition({ name: "retry-mount", sources: {
    docs: custom({ materialize: "build", mount: "parent/docs", files: [] }),
  } }, store)
  store.removeEmptyDirectory = async () => { throw new Error("remove failed") }
  await expect(syncWorkspaceDefinition({ name: "retry-mount", sources: {} }, store)).rejects.toThrow("remove failed")
  store.removeEmptyDirectory = remove
  await syncWorkspaceDefinition({ name: "retry-mount", sources: {} }, store)
  await expect(store.stat("parent")).resolves.toBeUndefined()
})

it("rechecks a directory replaced during cleanup inspection", async () => {
  const store = createMemoryWorkspaceStore()
  await syncWorkspaceDefinition({ name: "replaced-mount", sources: {
    docs: custom({ materialize: "build", mount: "docs", files: [] }),
  } }, store)
  const list = store.list.bind(store)
  let replaced = false
  store.list = async (path, options) => {
    const entries = await list(path, options)
    if (path === "docs" && !options?.recursive && !replaced) {
      replaced = true
      await store.rm("docs")
      await store.writeFile("docs", { path: "docs", content: "user replacement" })
    }
    return entries
  }
  await syncWorkspaceDefinition({ name: "replaced-mount", sources: {} }, store, new AbortController().signal)
  await expect(store.readFile("docs")).resolves.toMatchObject({ content: "user replacement" })
})

it("checkpoints accepted directory pruning after cancellation", async () => {
  const store = createMemoryWorkspaceStore()
  await syncWorkspaceDefinition({ name: "cancelled-prune", sources: {
    docs: custom({ materialize: "build", mount: "docs", files: [] }),
  } }, store)
  const remove = store.removeEmptyDirectory!.bind(store)
  const controller = new AbortController()
  store.removeEmptyDirectory = async (path) => {
    await remove(path)
    controller.abort(new Error("cancelled after prune"))
  }
  await expect(syncWorkspaceDefinition({ name: "cancelled-prune", sources: {} }, store, controller.signal)).rejects.toThrow("cancelled after prune")
  await store.mkdir("docs")
  await syncWorkspaceDefinition({ name: "cancelled-prune", sources: {} }, store)
  await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
})

it("preserves a file replacement admitted immediately before directory removal", async () => {
  const store = createMemoryWorkspaceStore()
  await syncWorkspaceDefinition({ name: "late-replacement", sources: {
    docs: custom({ materialize: "build", mount: "docs", files: [] }),
  } }, store)
  const remove = store.rm.bind(store)
  const removeDirectory = store.removeEmptyDirectory!.bind(store)
  let replaced = false
  const replace = async () => {
    if (replaced) return
    replaced = true
    await remove("docs")
    await store.writeFile("docs", { path: "docs", content: "user replacement" })
  }
  store.rm = async (path, options) => {
    await replace()
    await remove(path, options)
  }
  store.removeEmptyDirectory = async (path) => {
    await replace()
    await removeDirectory(path)
  }
  await syncWorkspaceDefinition({ name: "late-replacement", sources: {} }, store)
  await expect(store.readFile("docs")).resolves.toMatchObject({ content: "user replacement" })
})

it("retains generated directories for Stores without atomic directory removal", async () => {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  store.removeEmptyDirectory = undefined
  await syncWorkspaceDefinition({ name: "custom-store", sources: {
    docs: custom({ materialize: "build", mount: "docs", files: [] }),
  } }, store)
  await syncWorkspaceDefinition({ name: "custom-store", sources: {} }, store)
  await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
})
