import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, vi } from "vitest"

import { sha256 } from "../src/core/path.ts"
import { normalizeWorkspaceSources } from "../src/sources/config.ts"
import { hasCurrentSourceSnapshot, hasFreshSourceSnapshot, materializeWorkspaceSources, readCurrentSourceSnapshot, sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { workspaceStoreTarget } from "../src/storage/target.ts"
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts"
import { useWorkspace } from "../src/core/use.ts"
import { createWorkspaceSourceResolutionFacade } from "../src/sources/resolution.ts"
import { readWorkspaceSourceMaterializationStatus } from "../src/source-metadata.ts"
import { createWorkspaceSourceView } from "../src/sources/view.ts"

it.each(["sidecar", "tree"])("keeps cached Source paths read-only after losing the metadata %s", async (missing) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-missing-sidecar-"))
  const getItem = vi.fn(async (key: string) => ({ key, content: "original" }))
  const definition = {
    name: "missing-sidecar",
    sources: {
      docs: {
        cache: { maxAge: 3600 },
        mount: { path: "" },
        materialize: "startup" as const,
        async getKeys() { return ["docs/file.txt"] },
        getItem,
      },
    },
  }
  try {
    await materializeWorkspaceSources(definition, createLocalWorkspaceStore(root))
    const metadataRoot = join(root, ".vitehub", "file-metadata")
    await rm(missing === "tree" ? metadataRoot : join(metadataRoot, "docs/file.txt/metadata.json"), { recursive: true })
    const restarted = createLocalWorkspaceStore(root)
    const view = createWorkspaceSourceView(definition, restarted)
    await expect(view.writeFile("docs/file.txt", "overwrite")).rejects.toThrow("read-only")
    await expect(view.rm("docs/file.txt")).rejects.toThrow("read-only")
    await expect(view.rm("docs", { recursive: true })).rejects.toThrow("read-only")
    await expect(view.mkdir("docs/file.txt")).rejects.toThrow("read-only")
    await expect(view.writeFile("docs/generated.txt", "allowed")).resolves.toBe("docs/generated.txt")
    await expect(restarted.readFile("docs/file.txt")).resolves.toMatchObject({ content: new TextEncoder().encode("original") })
    expect(getItem).toHaveBeenCalledTimes(1)
    const withoutSource = createWorkspaceSourceView({ ...definition, sources: {} }, restarted)
    await expect(withoutSource.writeFile("docs/file.txt", "released")).resolves.toBe("docs/file.txt")
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.meta.json`, { force: true })
  }
})

it.each([
  { overlay: false, legacy: false },
  { overlay: true, legacy: false },
  { overlay: false, legacy: true },
  { overlay: true, legacy: true },
])("preserves local snapshot identity with overlay $overlay and legacy $legacy", async ({ overlay, legacy }) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-metadata-facade-"))
  const getItem = vi.fn(async (key: string) => ({ key, content: "original" }))
  const definition = {
    name: `metadata-facade-${crypto.randomUUID()}`,
    store: { provider: "local" as const, root },
    sources: {
      docs: {
        cache: { maxAge: 3600 },
        mount: { path: "" },
        materialize: "startup" as const,
        async getKeys() { return ["file.txt"] },
        getItem,
      },
    },
  }
  registerWorkspace(definition.name, { store: definition.store, sources: definition.sources })
  try {
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources(definition, store)
    const source = normalizeWorkspaceSources(definition.sources)[0]!
    if (legacy) {
      // Reproduce a restart from the pre-sidecar snapshot format.
      const snapshotKey = sourceSnapshotMetaKey(definition.name, source.key)
      const snapshot = await store.getMeta!(snapshotKey) as Record<string, unknown>
      const configHash = await sha256({
        cache: source.cache, key: source.key, materialize: source.materialize,
        mountPath: source.mountPath, source: source.source.fingerprint,
      })
      await store.setMeta!(snapshotKey, { ...snapshot, configHash })
      await rm(join(root, ".vitehub", "file-metadata"), { recursive: true, force: true })
    }
    const facade = useWorkspace(definition.name)
    const workspace = overlay ? (await createWorkspaceSourceResolutionFacade(facade, definition, {
      overlay,
      invocation: {
        context: {
          entries: () => new Map<string, unknown>().entries(),
          get: () => undefined,
          has: () => false,
          toJSON: () => ({}),
        },
      },
    })).workspace : facade
    const status = await readWorkspaceSourceMaterializationStatus(workspace, source)
    if (legacy) expect(status).toBeUndefined()
    else expect(status).toMatchObject({ status: "ready" })
    await workspace.fs.materializeSources!()
    if (legacy) expect(getItem.mock.calls.length).toBeGreaterThan(1)
    else expect(getItem).toHaveBeenCalledTimes(1)
    await expect(workspace.fs.stat("file.txt")).resolves.toMatchObject({ metadata: { source: "docs" } })
  }
  finally {
    resetWorkspaceRegistry()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["cloudflare-artifacts", "vercel-blob", "github"])("preserves legacy %s snapshots when the upstream source is unavailable", async (provider) => {
  const store = createMemoryWorkspaceStore()
  Object.assign(store, { [workspaceStoreTarget]: () => ({ provider }) })
  const getItem = vi.fn(async (key: string) => ({ key, content: "original" }))
  const getKeys = vi.fn(async () => ["file.txt"])
  const definition = {
    name: "hosted-metadata",
    sources: {
      docs: {
        cache: { maxAge: 3600 },
        mount: { path: "" },
        materialize: "startup" as const,
        getKeys,
        getItem,
      },
    },
  }
  await materializeWorkspaceSources(definition, store)
  const source = normalizeWorkspaceSources(definition.sources)[0]!
  const configHash = await sha256({
    cache: source.cache, key: source.key, materialize: source.materialize,
    mountPath: source.mountPath, source: source.source.fingerprint,
  })
  const snapshotKey = sourceSnapshotMetaKey(definition.name, source.key)
  const snapshot = await store.getMeta!(snapshotKey) as Record<string, unknown>
  await store.setMeta!(snapshotKey, { ...snapshot, configHash })
  getKeys.mockRejectedValue(new Error("Source unavailable"))
  getItem.mockRejectedValue(new Error("Source unavailable"))

  await expect(hasCurrentSourceSnapshot(store, definition.name, source)).resolves.toBe(true)
  await expect(hasFreshSourceSnapshot(store, definition.name, source)).resolves.toBe(true)
  await expect(readCurrentSourceSnapshot(store, definition.name, source)).resolves.toMatchObject({ configHash })
  const result = await materializeWorkspaceSources(definition, store)
  expect(result.sources[0]?.status).toBe("ready")
  expect(getKeys).toHaveBeenCalledTimes(1)
  expect(getItem).toHaveBeenCalledTimes(1)
  await expect(store.readFile("file.txt")).resolves.toMatchObject({ metadata: { source: "docs" } })
})

it("adopts an unscoped hosted cache without contacting an unavailable Source", async () => {
  const store = createMemoryWorkspaceStore()
  Object.assign(store, { [workspaceStoreTarget]: () => ({ provider: "cloudflare-artifacts" }) })
  const getKeys = vi.fn(async () => ["ready.md"])
  const getItem = vi.fn(async (key: string) => ({ key, content: "cached" }))
  const definition = {
    name: "legacy-namespace",
    sources: {
      docs: {
        cache: { maxAge: 3600 },
        materialize: "startup" as const,
        getKeys,
        getItem,
      },
    },
  }
  await materializeWorkspaceSources(definition, store)
  const scopedKey = sourceSnapshotMetaKey(definition.name, "docs")
  const snapshot = await store.getMeta!(scopedKey)
  await store.setMeta!("source:docs:snapshot", snapshot)
  await store.setMeta!(scopedKey, undefined)
  getKeys.mockRejectedValue(new Error("Source unavailable"))
  getItem.mockRejectedValue(new Error("Source unavailable"))

  await expect(materializeWorkspaceSources(definition, store)).resolves.toMatchObject({
    sources: [expect.objectContaining({ status: "ready" })],
  })
  await expect(store.getMeta!(scopedKey)).resolves.toEqual(snapshot)
  expect(getKeys).toHaveBeenCalledTimes(1)
  expect(getItem).toHaveBeenCalledTimes(1)
  await expect(store.readFile("docs/ready.md")).resolves.toMatchObject({ content: "cached" })
})

it("does not claim an unscoped snapshot with a different Source configuration", async () => {
  const store = createMemoryWorkspaceStore()
  const source = (path: string) => ({
    fingerprint: { path },
    materialize: "startup" as const,
    mount: "",
    async getKeys() { return [path] },
    async getItem(key: string) { return { key, content: key } },
  })
  const definition = { name: "legacy-other-owner", sources: { docs: source("other.md") } }
  await materializeWorkspaceSources(definition, store)
  const scopedKey = sourceSnapshotMetaKey(definition.name, "docs")
  await store.setMeta!("source:docs:snapshot", await store.getMeta!(scopedKey))
  await store.setMeta!(scopedKey, undefined)

  await materializeWorkspaceSources({ name: "new-owner", sources: { docs: source("current.md") } }, store)
  await expect(store.readFile("other.md")).resolves.toMatchObject({ content: "other.md" })
  await expect(store.readFile("current.md")).resolves.toMatchObject({ content: "current.md" })
})

it.each([3600, 0])("restores legacy materialization ownership with cache maxAge %i", async (maxAge) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-metadata-migration-"))
  const sidecars = join(root, ".vitehub", "file-metadata")
  try {
    const getItem = vi.fn(async (key: string) => ({ key, content: "original", mediaType: "text/plain" }))
    const definition = {
      name: "legacy-metadata",
      sources: {
        docs: {
          cache: { maxAge },
          mount: { path: "" },
          materialize: "startup" as const,
          async getKeys() { return ["file.txt"] },
          async getMeta() { return { etag: "unchanged" } },
          getItem,
        },
      },
    }
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources(definition, store)
    expect(getItem).toHaveBeenCalledTimes(1)

    // Reproduce the pre-sidecar snapshot format and its metadata-free files.
    const source = normalizeWorkspaceSources(definition.sources)[0]!
    const configHash = await sha256({
      cache: source.cache, key: source.key, materialize: source.materialize,
      mountPath: source.mountPath, source: source.source.fingerprint,
    })
    const snapshotKey = sourceSnapshotMetaKey(definition.name, source.key)
    const snapshot = await store.getMeta!(snapshotKey) as Record<string, unknown>
    await store.setMeta!(snapshotKey, {
      ...snapshot, configHash,
      materializedAt: new Date(Date.now() - 1000).toISOString(),
    })
    await rm(sidecars, { recursive: true, force: true })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile("file.txt")).resolves.toMatchObject({ metadata: undefined })
    const result = await materializeWorkspaceSources(definition, restarted)
    expect(result.sources[0]?.status).toBe("ready")
    expect(getItem).toHaveBeenCalledTimes(2)
    await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("original"), mediaType: "text/plain",
      metadata: { source: "docs", sourcePath: "file.txt" },
    })
    await materializeWorkspaceSources(definition, createLocalWorkspaceStore(root))
    expect(getItem).toHaveBeenCalledTimes(2)
  }
  finally {
    await Promise.all([root, sidecars, `${root}.meta.json`, `${root}.vitehub-locks`, `${root}.vitehub-lock`]
      .map(path => rm(path, { recursive: true, force: true })))
  }
})

it.each([3600, 0])("converges scoped legacy materialization ownership with cache maxAge %i", async (maxAge) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-metadata-migration-"))
  const sidecars = join(root, ".vitehub", "file-metadata")
  try {
    const getItem = vi.fn(async (key: string) => ({ key, content: "original", mediaType: "text/plain" }))
    const definition = {
      name: "legacy-metadata",
      sources: {
        docs: {
          cache: { maxAge },
          mount: { path: "" },
          materialize: "startup" as const,
          async getKeys() { return ["docs/file.txt", "other.txt"] },
          async getMeta() { return { etag: "unchanged" } },
          getItem,
        },
      },
    }
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources(definition, store)
    expect(getItem).toHaveBeenCalledTimes(2)

    // Reproduce the pre-sidecar snapshot format and its metadata-free files.
    const source = normalizeWorkspaceSources(definition.sources)[0]!
    const configHash = await sha256({
      cache: source.cache, key: source.key, materialize: source.materialize,
      mountPath: source.mountPath, source: source.source.fingerprint,
    })
    const snapshotKey = sourceSnapshotMetaKey(definition.name, source.key)
    const snapshot = await store.getMeta!(snapshotKey) as Record<string, unknown>
    await store.setMeta!(snapshotKey, {
      ...snapshot, configHash,
      materializedAt: new Date(Date.now() - 1000).toISOString(),
    })
    await rm(sidecars, { recursive: true, force: true })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile("docs/file.txt")).resolves.toMatchObject({ metadata: undefined })
    const result = await materializeWorkspaceSources(definition, restarted, { path: "docs" })
    expect(result.sources[0]?.status).toBe("ready")
    expect(getItem).toHaveBeenCalledTimes(3)
    await expect(createLocalWorkspaceStore(root).readFile("docs/file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("original"), mediaType: "text/plain",
      metadata: { source: "docs", sourcePath: "docs/file.txt" },
    })
    await expect(createLocalWorkspaceStore(root).getMeta!(snapshotKey)).resolves.toMatchObject({ status: "updating" })
    await materializeWorkspaceSources(definition, createLocalWorkspaceStore(root), { path: "docs" })
    expect(getItem).toHaveBeenCalledTimes(3)
    await expect(restarted.readFile("other.txt")).resolves.toMatchObject({ metadata: undefined })
    await materializeWorkspaceSources(definition, createLocalWorkspaceStore(root))
    expect(getItem).toHaveBeenCalledTimes(4)
    await expect(restarted.readFile("other.txt")).resolves.toMatchObject({ metadata: { source: "docs" } })
    await expect(createLocalWorkspaceStore(root).getMeta!(snapshotKey)).resolves.toMatchObject({ status: "ready", files: 2 })
  }
  finally {
    await Promise.all([root, sidecars, `${root}.meta.json`, `${root}.vitehub-locks`, `${root}.vitehub-lock`]
      .map(path => rm(path, { recursive: true, force: true })))
  }
})

it.each(["enumeration", "item"])("preserves unowned legacy files after failed %s and restart", async (failure) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-migration-retry-"))
  let unavailable = false
  let keys = ["kept.txt", "removed.txt"]
  const getItem = vi.fn(async (key: string) => {
    if (unavailable && failure === "item") throw new Error("Source unavailable")
    return { key, content: "original" }
  })
  const definition = {
    name: "migration-retry",
    sources: {
      docs: {
        mount: { path: "" },
        materialize: "startup" as const,
        async getKeys() {
          if (unavailable && failure === "enumeration") throw new Error("Source unavailable")
          return keys
        },
        async getMeta() { return { etag: "unchanged" } },
        getItem,
      },
    },
  }
  try {
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources(definition, store)
    const source = normalizeWorkspaceSources(definition.sources)[0]!
    const configHash = await sha256({
      cache: source.cache, key: source.key, materialize: source.materialize,
      mountPath: source.mountPath, source: source.source.fingerprint,
    })
    const snapshotKey = sourceSnapshotMetaKey(definition.name, source.key)
    const snapshot = await store.getMeta!(snapshotKey) as Record<string, unknown>
    await store.setMeta!(snapshotKey, { ...snapshot, configHash })
    await rm(join(root, ".vitehub/file-metadata"), { recursive: true })
    unavailable = true
    for (let attempt = 0; attempt < 2; attempt++) {
      const restarted = createLocalWorkspaceStore(root)
      const result = await materializeWorkspaceSources(definition, restarted)
      expect(result.sources[0]?.status).toBe("error")
      await expect(readCurrentSourceSnapshot(restarted, definition.name, source)).resolves.toMatchObject({
        items: {
          "kept.txt": { migrationPending: true },
          "removed.txt": { migrationPending: true },
        },
      })
      const view = createWorkspaceSourceView(definition, restarted)
      await expect(view.writeFile("kept.txt", "overwrite")).rejects.toThrow("read-only")
      await expect(view.rm("removed.txt")).rejects.toThrow("read-only")
    }
    unavailable = false
    keys = ["kept.txt"]
    const restarted = createLocalWorkspaceStore(root)
    const result = await materializeWorkspaceSources(definition, restarted)
    expect(result.sources[0]?.status).toBe("ready")
    await expect(restarted.readFile("kept.txt")).resolves.toMatchObject({ metadata: { source: "docs" } })
    await expect(restarted.readFile("removed.txt")).resolves.toMatchObject({ content: new TextEncoder().encode("original") })
    const ready = await readCurrentSourceSnapshot(restarted, definition.name, source)
    expect(ready?.items?.["kept.txt"]).not.toHaveProperty("migrationPending")
    expect(ready?.items).not.toHaveProperty("removed.txt")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refreshes keyed items after another Workspace replaces their content", async () => {
  const store = createMemoryWorkspaceStore()
  const definition = (name: string) => ({
    name,
    sources: { docs: {
      materialize: "startup" as const,
      async getKeys() { return ["shared.md"] },
      async getMeta() { return { etag: "stable" } },
      async getItem(key: string) { return { key, content: name } },
    } },
  })
  await materializeWorkspaceSources(definition("first"), store)
  await materializeWorkspaceSources(definition("second"), store)
  await materializeWorkspaceSources(definition("first"), store)
  await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({
    content: "first", metadata: { workspaceSourceOwner: "first" },
  })
})

it.each(["removal", "refresh"])("preserves unowned legacy cached files during %s", async (operation) => {
  const store = createMemoryWorkspaceStore()
  const getKeys = vi.fn(async () => ["shared.md"])
  const source = {
    materialize: "startup" as const,
    cache: { maxAge: 3600 },
    getKeys,
    async getItem(key: string) { return { key, content: "legacy" } },
  }
  const first = { name: "first", sources: { docs: source } }
  await materializeWorkspaceSources(first, store)
  await store.setMeta!("source:docs:snapshot", await store.getMeta!(sourceSnapshotMetaKey("first", "docs")))
  await store.setMeta!(sourceSnapshotMetaKey("first", "docs"), undefined)
  await store.writeFile("docs/shared.md", { path: "docs/shared.md", content: "legacy", metadata: { source: "docs" } })
  const second = { name: "second", sources: { docs: source } }
  await materializeWorkspaceSources(second, store)
  if (operation === "removal") {
    await materializeWorkspaceSources({ name: "second", sources: {} }, store)
  }
  else {
    getKeys.mockResolvedValue([])
    await materializeWorkspaceSources({ ...second, sources: { docs: { ...source, cache: { maxAge: 0 } } } }, store)
  }
  await expect(store.readFile("docs/shared.md")).resolves.toMatchObject({ content: "legacy" })
})
