import { expect, it } from "vitest"
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
