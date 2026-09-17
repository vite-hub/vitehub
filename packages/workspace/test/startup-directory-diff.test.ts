import { afterEach, describe, expect, it } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(resetWorkspaceRegistry)

describe("startup directory cleanup diffs", () => {
  it.each(["content", "metadata"])("excludes promoted Skills but preserves user changes to %s", async (attribute) => {
    const store = createMemoryWorkspaceStore()
    const baseline = await store.snapshot()
    const path = ".agents/skills/review/SKILL.md"
    registerWorkspace("promoted-diff", defineWorkspace({ store, sources: {
      portal: custom({ materialize: "startup", files: [{ path, content: "# Review" }] }),
    } }))
    const workspace = await useRegisteredWorkspace("promoted-diff")
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries).toEqual([])
    expect((await workspace.diff({ from: baseline })).entries).toContainEqual(expect.objectContaining({ path, type: "added" }))
    const file = (await store.readFile(path))!
    await store.writeFile(path, { ...file, ...(attribute === "content" ? { content: "User Skill" } : { metadata: { owner: "user" } }) })
    expect((await workspace.diff()).entries).toContainEqual(expect.objectContaining({ path, type: "added" }))
  })

  it.each(["startup", "lazy"] as const)("preserves retirement diff ownership for %s promoted Skills", async (materialize) => {
    const store = createMemoryWorkspaceStore()
    const path = ".agents/skills/review/SKILL.md"
    const sources = { portal: custom({ materialize, files: [{ path: ".claude/skills/review/SKILL.md", content: "# Review" }] }) }
    registerWorkspace("retired-promotion-diff", defineWorkspace({ store, sources }))
    const workspace = await useRegisteredWorkspace("retired-promotion-diff")
    await workspace.materializeSources?.()
    const baseline = await workspace.snapshot()
    Reflect.deleteProperty(sources, "portal")
    await workspace.materializeSources?.()
    expect(await store.readFile(path)).toBeUndefined()
    const deletion = expect.objectContaining({ path, type: "removed" })
    if (materialize === "startup") expect((await workspace.diff()).entries).toEqual([])
    else expect((await workspace.diff()).entries).toContainEqual(deletion)
    expect((await workspace.diff({ from: baseline })).entries).toContainEqual(deletion)
    resetWorkspaceRegistry()
    registerWorkspace("retired-promotion-diff", defineWorkspace({ store, sources }))
    const restarted = await useRegisteredWorkspace("retired-promotion-diff")
    if (materialize === "startup") expect((await restarted.diff()).entries).toEqual([])
    await restarted.writeFile(path, "User Skill")
    expect((await restarted.diff()).entries).toContainEqual(expect.objectContaining({ path }))
    await restarted.rm(path)
    expect((await restarted.diff()).entries).toContainEqual(deletion)
  })

  it("excludes synthesized startup parents while retaining user files and empty directories", async () => {
    const store = createMemoryWorkspaceStore()
    const mkdir = store.mkdir.bind(store)
    store.mkdir = async (path, options) => await mkdir(path, { recursive: options?.recursive })
    await store.snapshot()
    registerWorkspace("synthetic-diff", defineWorkspace({ store, sources: {
      generated: custom({ materialize: "startup", mount: "docs/generated", files: [{ path: "nested/file.md", content: "Generated" }] }),
    } }))
    const workspace = await useRegisteredWorkspace("synthetic-diff")
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries).toEqual([])
    await store.mkdir("docs/empty", { recursive: true })
    await store.writeFile("docs/user.md", { path: "docs/user.md", content: "User" })
    expect((await workspace.diff()).entries.map(entry => entry.path)).toEqual(["docs", "docs/empty", "docs/user.md"])
  })

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
