import { afterEach, describe, expect, it } from "vitest"

import { custom, defineWorkspace, useWorkspace, type ReadonlyWorkspaceFacade, type WorkspaceDefinition, type WritableWorkspaceFacade } from "../src/index.ts"
import { resetWorkspaceRegistry } from "../src/core/registry.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createWorkspaceSourceResolutionFacade, forwardWorkspaceMetadataView } from "../src/runtime.ts"
import { listMaterializedWorkspaceEntries, normalizeWorkspaceSourceMetadata, readWorkspaceSourceMaterializationStatus } from "../src/source-metadata.ts"
import { resolveWorkspaceMetadataTarget } from "../src/storage/metadata-target.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { resolveWorkspaceStoreTarget } from "../src/storage/target.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
})

const globalKey = Symbol.for("vitehub.workspace.metadataTarget")

const invocation = {
  context: {
    entries: () => new Map<string, unknown>().entries(),
    get: () => undefined,
    has: () => false,
    toJSON: () => ({}),
  },
}

const docs = custom({
  materialize: "lazy",
  mount: "docs",
  async getKeys() {
    return ["guide.md"]
  },
  async getItem(key) {
    return { key, path: key, content: "# Guide\n" }
  },
})

function expectNoGlobalCarrier(value: object) {
  expect(Reflect.get(value, globalKey)).toBeUndefined()
  expect(Object.getOwnPropertySymbols(value)).not.toContain(globalKey)
}

describe("Workspace metadata target", () => {
  it("is not reachable through the global symbol registry", async () => {
    const store = createMemoryWorkspaceStore()
    registerWorkspace("support", defineWorkspace({ store, sources: { docs } }))
    const core = createWorkspace({ name: "support", sources: { docs }, store })
    const writable = useWorkspace("support", { mode: "write" })
    const readonly = useWorkspace("support")
    const definition: WorkspaceDefinition = { name: "support", sources: { docs } }
    const overlay = (await createWorkspaceSourceResolutionFacade(writable, definition, { invocation, overlay: true })).workspace

    for (const value of [core, writable, writable.fs, readonly, readonly.fs, overlay, overlay.fs]) expectNoGlobalCarrier(value)

    // Workspace internals still find the target.
    await expect(resolveWorkspaceMetadataTarget(core)).resolves.toMatchObject({ workspaceName: "support" })
    await expect(resolveWorkspaceMetadataTarget(writable)).resolves.toMatchObject({ workspaceName: "support" })
    await expect(listMaterializedWorkspaceEntries(readonly)).resolves.toEqual([])
    // The Source mount stays read-only, and no raw writer reached the Store.
    await expect(writable.fs.writeFile("docs/guide.md", "forged")).rejects.toThrow("read-only")
    await expect(store.stat("docs/guide.md")).resolves.toBeUndefined()
  })

  it("ignores a global symbol that a caller plants on an object", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("notes/private.md", { path: "notes/private.md", content: "private" })
    const planted = {
      [globalKey]: () => ({
        workspaceName: "support",
        getMeta: store.getMeta!.bind(store),
        list: store.list.bind(store),
      }),
    }

    await expect(resolveWorkspaceMetadataTarget(planted)).resolves.toBeUndefined()
    await expect(listMaterializedWorkspaceEntries(planted)).resolves.toBeUndefined()
    await expect(readWorkspaceSourceMaterializationStatus(planted, normalizeWorkspaceSourceMetadata("docs", docs))).resolves.toBeUndefined()
  })

  it("forwards only a read-only metadata view", async () => {
    const store = createMemoryWorkspaceStore()
    await store.writeFile("docs/a.md", { path: "docs/a.md", content: "a" })
    await store.writeFile("notes/b.md", { path: "notes/b.md", content: "b" })
    await store.setMeta!("app:state", { ok: true })
    registerWorkspace("support", defineWorkspace({ store }))
    const writable: WritableWorkspaceFacade = useWorkspace("support", { mode: "write" })
    // A new facade, as the Agent access capability creates one.
    const readonly = useWorkspace("support")
    const target: ReadonlyWorkspaceFacade = { fs: readonly.fs, tools: readonly.tools, history: readonly.history }
    forwardWorkspaceMetadataView(writable, target, entries => entries.filter(entry => entry.path.startsWith("docs")))

    const view = await resolveWorkspaceMetadataTarget(target)
    expect(view && Object.keys(view).sort()).toEqual(["getMeta", "list", "workspaceName"])
    await expect(view?.getMeta?.("app:state")).resolves.toEqual({ ok: true })
    await expect(view?.list?.("", { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "docs" }),
      expect.objectContaining({ path: "docs/a.md" }),
    ])
    await expect(resolveWorkspaceStoreTarget(view)).resolves.toEqual({ provider: "memory" })
    expectNoGlobalCarrier(target)

    // A source without a target gives nothing.
    const empty: ReadonlyWorkspaceFacade = { fs: { ...readonly.fs }, tools: readonly.tools, history: readonly.history }
    forwardWorkspaceMetadataView({}, empty)
    await expect(resolveWorkspaceMetadataTarget(empty)).resolves.toBeUndefined()
  })
})
