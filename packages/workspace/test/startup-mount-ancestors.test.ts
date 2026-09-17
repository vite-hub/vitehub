import { afterEach, expect, it } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(resetWorkspaceRegistry)

it.each(["created", "pre-existing", "replaced"])("retires nested mounts while respecting %s ancestors", async (ancestor) => {
  const store = createMemoryWorkspaceStore()
  if (ancestor === "pre-existing") await store.mkdir("docs")
  const sources = { generated: custom({
    materialize: "startup",
    mount: "docs/nested/generated",
    files: [{ path: "file.md", content: "generated" }],
  }) }
  registerWorkspace("mount-ancestors", defineWorkspace({ store, sources }))
  const workspace = await useRegisteredWorkspace("mount-ancestors")
  await workspace.materializeSources?.()
  expect(await store.readFile("docs/nested/generated/file.md")).toBeDefined()
  if (ancestor === "replaced") {
    // Another Store consumer can replace directories outside the Source view.
    await store.rm("docs", { recursive: true })
    await store.mkdir("docs")
  }
  Reflect.deleteProperty(sources, "generated")
  await workspace.materializeSources?.()
  expect(await store.stat("docs/nested")).toBeUndefined()
  if (ancestor === "created") expect(await store.stat("docs")).toBeUndefined()
  else expect(await store.stat("docs")).toEqual(expect.objectContaining({ type: "directory" }))
})
