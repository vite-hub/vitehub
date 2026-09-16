import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition } from "../src/core/types.ts"

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
