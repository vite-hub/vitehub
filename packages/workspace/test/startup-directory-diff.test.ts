import { afterEach, describe, expect, it } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(resetWorkspaceRegistry)

describe("startup directory cleanup diffs", () => {
  it.each(["refresh", "retirement"])("excludes generated directories after %s while preserving historical diffs", async (operation) => {
    let keys = ["nested/file.md"]
    const sources = { generated: custom({
      materialize: "startup",
      mount: "docs/generated",
      async getKeys() { return keys },
      async getItem(key) { return { key, content: key } },
    }) }
    registerWorkspace("directory-diff", defineWorkspace({ store: { provider: "memory" }, sources }))
    const workspace = await useRegisteredWorkspace("directory-diff")
    await workspace.materializeSources?.()
    const baseline = await workspace.snapshot()
    if (operation === "retirement") Reflect.deleteProperty(sources, "generated")
    else keys = []
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries).toEqual([])
    expect((await workspace.diff({ from: baseline })).entries).toContainEqual(expect.objectContaining({ path: "docs/generated/nested", type: "removed" }))
  })

  it.each(["mkdir", "writeFile"])("keeps user directory deletions visible after recreation with %s", async (operation) => {
    const sources = { generated: custom({ materialize: "startup", files: [{ path: "nested/file.md", content: "generated" }] }) }
    const store = createMemoryWorkspaceStore()
    registerWorkspace("recreated-directory-diff", defineWorkspace({ store, sources }))
    const workspace = await useRegisteredWorkspace("recreated-directory-diff")
    await workspace.materializeSources?.()
    await workspace.snapshot()
    Reflect.deleteProperty(sources, "generated")
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries).toEqual([])
    resetWorkspaceRegistry()
    registerWorkspace("recreated-directory-diff", defineWorkspace({ store, sources }))
    const restarted = await useRegisteredWorkspace("recreated-directory-diff")
    if (operation === "mkdir") await restarted.mkdir("generated/nested", { recursive: true })
    else await restarted.writeFile("generated/nested/user.md", "user")
    await restarted.rm("generated", { recursive: true })
    expect((await restarted.diff()).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "generated", type: "removed" }),
      expect.objectContaining({ path: "generated/nested", type: "removed" }),
    ]))
  })
})
