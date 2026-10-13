import { afterEach, describe, expect, it, vi } from "vitest"

import { custom, defineWorkspace } from "../src/index.ts"
import { sha256 } from "../src/core/path.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createWorkspaceSourceMountAuthority, type WorkspaceSourceMountGrant } from "../src/sources/mount-grants.ts"
import { sourceSyncMetaKey } from "../src/sources/sync-state.ts"
import { createWorkspaceSourceView, type WorkspaceSourceWriteGrant } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

import type { WorkspaceDefinition, WorkspaceRebaseOptions } from "../src/core/types.ts"

afterEach(() => {
  resetWorkspaceRegistry()
})

function docsSource(options: { materialize?: "lazy" | "startup", mount?: string, sync?: { stale: "remove" } } = {}) {
  return custom({
    materialize: options.materialize,
    mount: options.mount ?? "docs",
    sync: options.sync,
    async getKeys() {
      return ["guide.md"]
    },
    async getItem(key) {
      return { key, path: key, content: "# Guide\n" }
    },
  })
}

describe("Source mount grants", () => {
  it("limits file changes to the mount of the grant", async () => {
    const authority = createWorkspaceSourceMountAuthority("Test owner")
    const store = createMemoryWorkspaceStore()
    const grant = authority.grant({ key: "docs", mountPath: "content\\docs/" })
    const scoped = authority.store(grant, store)

    expect(grant).toMatchObject({ mountPath: "content/docs", source: "docs" })
    expect(Object.isFrozen(grant)).toBe(true)
    await scoped.mkdir("content/docs", { recursive: true })
    await scoped.writeFile("content/docs/guide.md", { path: "content/docs/guide.md", content: "ok" })
    await scoped.rm("content/docs/guide.md")
    await scoped.removeEmptyDirectory!("content/docs")
    await scoped.removeEmptyDirectory!("content")

    await expect(scoped.writeFile("notes/a.md", { path: "notes/a.md", content: "nope" })).rejects.toThrow("outside its mount")
    await expect(scoped.writeFile("content/docs/../../notes/a.md", { path: "notes/a.md", content: "nope" })).rejects.toThrow()
    await expect(scoped.writeFile("content/docs-other/a.md", { path: "content/docs-other/a.md", content: "nope" })).rejects.toThrow("outside its mount")
    await expect(scoped.mkdir("content")).rejects.toThrow("outside its mount")
    await expect(scoped.rm("content", { force: true, recursive: true })).rejects.toThrow("outside its mount")
    await expect(scoped.removeEmptyDirectory!("notes")).rejects.toThrow("outside its mount")
    await expect(store.stat("notes/a.md")).resolves.toBeUndefined()
  })

  it("lets a root Source change every path", async () => {
    const authority = createWorkspaceSourceMountAuthority("Test owner")
    const scoped = authority.store(authority.grant({ key: "root", mountPath: "" }), createMemoryWorkspaceStore())

    await expect(scoped.writeFile("notes/a.md", { path: "notes/a.md", content: "ok" })).resolves.toBeUndefined()
  })

  it("rejects forged, missing, and foreign grants", async () => {
    const authority = createWorkspaceSourceMountAuthority("Test owner")
    const other = createWorkspaceSourceMountAuthority("Other owner")
    const store = createMemoryWorkspaceStore()
    const issued = authority.grant({ key: "docs", mountPath: "docs" })
    const GrantClass = issued.constructor as new (source: string, mountPath: string) => WorkspaceSourceMountGrant
    // SAFETY: These values simulate JavaScript callers that bypass the TypeScript contract.
    const forged = [
      { mountPath: "", source: "docs" },
      Object.freeze({ mountPath: "docs", source: "docs" }),
      Object.create(issued),
      new GrantClass("docs", ""),
      other.grant({ key: "docs", mountPath: "docs" }),
      undefined,
      null,
      "docs",
    ] as unknown as WorkspaceSourceMountGrant[]

    for (const grant of forged) {
      expect(() => authority.store(grant, store)).toThrow("requires a Source mount grant")
    }
  })
})

describe("Source Sync owner grants", () => {
  it("does not remove files that another Workspace synced into its own mount", async () => {
    const store = createMemoryWorkspaceStore()
    registerWorkspace("sync-owner-a", defineWorkspace({ store, sources: { docs: docsSource({ mount: "a", sync: { stale: "remove" } }) } }))
    registerWorkspace("sync-owner-b", defineWorkspace({ store, sources: { docs: docsSource({ mount: "b", sync: { stale: "remove" } }) } }))
    const a = await useRegisteredWorkspace("sync-owner-a")
    const b = await useRegisteredWorkspace("sync-owner-b")

    await expect(a.sync({ sources: ["docs"] })).resolves.toMatchObject({ status: "ready" })
    // Both Workspaces share the sync state key of the Source.
    await expect(b.sync({ details: "paths", sources: ["docs"] })).resolves.toMatchObject({
      sources: [expect.objectContaining({ counts: expect.objectContaining({ removed: 0 }), status: "ready" })],
    })
    await expect(a.sync({ sources: ["docs"] })).resolves.toMatchObject({ status: "ready" })

    await expect(store.readFile("a/guide.md")).resolves.toMatchObject({ content: "# Guide\n" })
    await expect(store.readFile("b/guide.md")).resolves.toMatchObject({ content: "# Guide\n" })
  })

  it("ignores sync state paths outside the Source mount", async () => {
    const store = createMemoryWorkspaceStore()
    registerWorkspace("sync-forged-state", defineWorkspace({ store, sources: { docs: docsSource({ sync: { stale: "remove" } }) } }))
    const workspace = await useRegisteredWorkspace("sync-forged-state")
    await store.writeFile("notes/private.md", { path: "notes/private.md", content: "private" })
    await store.setMeta!(sourceSyncMetaKey("docs", "sync-forged-state"), {
      configHash: "forged",
      mountPath: "",
      paths: { "notes/private.md": { digest: await sha256("private"), sourcePath: "private.md" } },
      source: "docs",
    })

    await expect(workspace.sync({ sources: ["docs"] })).resolves.toMatchObject({ status: "ready" })
    await expect(store.readFile("notes/private.md")).resolves.toMatchObject({ content: "private" })
  })
})

describe("Source materialization owner grants", () => {
  it("does not remove snapshot paths outside the Source mount", async () => {
    const name = "materialization-forged-snapshot"
    const store = createMemoryWorkspaceStore()
    const definition: WorkspaceDefinition = { name, sources: { docs: docsSource({ materialize: "startup" }) }, store }
    await store.writeFile("notes/private.md", {
      path: "notes/private.md",
      content: "private",
      metadata: { source: "docs", workspaceSourceOwner: name },
    })
    await store.setMeta!(sourceSnapshotMetaKey(name, "docs"), {
      configHash: "forged",
      items: {
        "notes/private.md": {
          materializedAt: new Date().toISOString(),
          materializedContentDigest: await sha256("private"),
          source: "docs",
          sourcePath: "private.md",
        },
      },
      mountPath: "docs",
      source: "docs",
      status: "ready",
    })

    const result = await createWorkspaceSourceView(definition, store).materializeSources({ sources: ["docs"] })

    expect(result.sources).toEqual([expect.objectContaining({ error: expect.stringContaining("outside its mount"), status: "error" })])
    await expect(store.readFile("notes/private.md")).resolves.toMatchObject({ content: "private" })
  })
})

describe("history.rebase owner grants", () => {
  function rebasingStore() {
    const store = createMemoryWorkspaceStore()
    // Simulates remote history that takes the remote version of each takeRemote path.
    const rebase = vi.fn(async (options?: WorkspaceRebaseOptions) => {
      for (const path of options?.takeRemote ?? []) await store.writeFile(path, { path, content: "remote" })
    })
    store.rebase = rebase
    return { rebase, store }
  }

  it("rejects takeRemote paths under a Source mount", async () => {
    const { rebase, store } = rebasingStore()
    const workspace = createWorkspace({ name: "rebase-source-path", sources: { docs: docsSource({ materialize: "lazy" }) }, store })

    await expect(workspace.readFile("docs/guide.md")).resolves.toBe("# Guide\n")
    await expect(workspace.rebase({ takeRemote: ["docs/guide.md"] })).rejects.toThrow("read-only")
    await expect(workspace.rebase({ takeRemote: ["notes/a.md", "docs"] })).rejects.toThrow("read-only")
    expect(rebase).not.toHaveBeenCalled()
    await expect(workspace.readFile("docs/guide.md")).resolves.toBe("# Guide\n")
  })

  it("passes granted takeRemote paths to the Store", async () => {
    const { rebase, store } = rebasingStore()
    const workspace = createWorkspace({ name: "rebase-writable-path", sources: { docs: docsSource({ materialize: "lazy" }) }, store })

    await workspace.rebase()
    await workspace.rebase({ takeRemote: ["notes\\a.md"] })

    expect(rebase).toHaveBeenNthCalledWith(1, undefined)
    expect(rebase).toHaveBeenNthCalledWith(2, { takeRemote: ["notes/a.md"] })
    await expect(workspace.readFile("notes/a.md")).resolves.toBe("remote")
  })

  it("rejects forged, missing, foreign, and wrong-path rebase grants", async () => {
    const definition: WorkspaceDefinition = { name: "rebase-grants", sources: { docs: docsSource({ materialize: "lazy" }) }, store: { provider: "memory" } }
    const view = createWorkspaceSourceView(definition, createMemoryWorkspaceStore())
    const other = createWorkspaceSourceView({ ...definition, name: "rebase-grants-other" }, createMemoryWorkspaceStore())
    const rebase = vi.fn(async (_options?: WorkspaceRebaseOptions) => {})
    const guarded = view.requireRebaseGrants(rebase)
    const grant = await view.assertWritable("notes/a.md")
    const takeRemote = { takeRemote: ["notes/a.md"] }
    // SAFETY: These values simulate JavaScript callers that bypass the TypeScript contract.
    const forged = [
      [],
      [{ path: "notes/a.md" }],
      [Object.create(grant)],
      [await other.assertWritable("notes/a.md")],
      [await view.assertWritable("notes/b.md")],
      [grant, grant],
      undefined,
      "notes/a.md",
    ] as unknown as WorkspaceSourceWriteGrant[][]

    for (const grants of forged) {
      await expect(guarded(grants, takeRemote)).rejects.toThrow("requires")
    }
    await expect(guarded([grant], { takeRemote: ["docs/guide.md"] })).rejects.toThrow("requires a Source write grant")
    expect(rebase).not.toHaveBeenCalled()
    await guarded([grant], { takeRemote: ["notes/a.md/"] })
    expect(rebase).toHaveBeenCalledWith(takeRemote)
  })
})
