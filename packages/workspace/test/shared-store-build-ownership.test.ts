import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

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
