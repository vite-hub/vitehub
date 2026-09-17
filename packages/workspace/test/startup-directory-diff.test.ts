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

  it("preserves user-owned parents of promoted Skills", async () => {
    const store = createMemoryWorkspaceStore()
    await store.snapshot()
    await store.mkdir(".agents/skills/review", { recursive: true })
    registerWorkspace("promoted-user-directory", defineWorkspace({ store, sources: {
      portal: custom({ materialize: "startup", files: [{ path: ".claude/skills/review/SKILL.md", content: "# Review" }] }),
    } }))
    const workspace = await useRegisteredWorkspace("promoted-user-directory")
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries.map(entry => entry.path)).toEqual([".agents", ".agents/skills", ".agents/skills/review"])
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

  it.each([
    { path: "docs", identities: true },
    { path: "docs/nested", identities: true },
    { path: "docs", identities: false },
    { path: "docs/nested", identities: false },
  ])("preserves a user-created directory containing only startup files: $path, identities: $identities", async ({ path, identities }) => {
    const store = createMemoryWorkspaceStore()
    await store.snapshot()
    await store.mkdir(path, { recursive: true })
    if (!identities) {
      const stat = store.stat.bind(store)
      store.stat = async (path) => {
        const entry = await stat(path)
        if (entry) delete entry.directoryIdentity
        return entry
      }
      const mkdir = store.mkdir.bind(store)
      store.mkdir = async (path, options) => await mkdir(path, { recursive: options?.recursive })
    }
    registerWorkspace("user-directory", defineWorkspace({ store, sources: {
      generated: custom({ materialize: "startup", mount: "docs", files: [{ path: "nested/AGENTS.md", content: "Generated" }] }),
    } }))
    const workspace = await useRegisteredWorkspace("user-directory")
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries).toContainEqual(expect.objectContaining({ path, type: "added" }))
  })

  it("retains directories of unknown ownership while excluding generated files", async () => {
    const store = createMemoryWorkspaceStore()
    const stat = store.stat.bind(store)
    store.stat = async (path) => {
      const entry = await stat(path)
      if (entry) delete entry.directoryIdentity
      return entry
    }
    const mkdir = store.mkdir.bind(store)
    store.mkdir = async (path, options) => await mkdir(path, { recursive: options?.recursive })
    await store.snapshot()
    registerWorkspace("synthetic-diff", defineWorkspace({ store, sources: {
      generated: custom({ materialize: "startup", mount: "docs/generated", files: [{ path: "nested/file.md", content: "Generated" }] }),
    } }))
    const workspace = await useRegisteredWorkspace("synthetic-diff")
    await workspace.materializeSources?.()
    expect((await workspace.diff()).entries.map(entry => entry.path)).toEqual(["docs", "docs/generated", "docs/generated/nested"])
    await store.mkdir("docs/empty", { recursive: true })
    await store.writeFile("docs/user.md", { path: "docs/user.md", content: "User" })
    expect((await workspace.diff()).entries.map(entry => entry.path)).toEqual(["docs", "docs/empty", "docs/generated", "docs/generated/nested", "docs/user.md"])
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

  it.each(["mkdir", "writeFile", "store-mkdir", "store-writeFile"])("keeps user directory deletions visible after recreation with %s", async (operation) => {
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
    if (operation === "store-mkdir") await store.mkdir("generated/nested", { recursive: true })
    else if (operation === "store-writeFile") await store.writeFile("generated/nested/user.md", { path: "generated/nested/user.md", content: "user" })
    else if (operation === "mkdir") await restarted.mkdir("generated/nested", { recursive: true })
    else await restarted.writeFile("generated/nested/user.md", "user")
    if (operation.startsWith("store-")) await store.rm("generated", { recursive: true })
    else await restarted.rm("generated", { recursive: true })
    expect((await restarted.diff()).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "generated", type: "removed" }),
      expect.objectContaining({ path: "generated/nested", type: "removed" }),
    ]))
  })
})
