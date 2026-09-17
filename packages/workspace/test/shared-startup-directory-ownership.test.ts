import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { registerWorkspace, useWorkspace } from "../src/runtime.ts"
import { materializeWorkspaceSources, reconcileRemovedStartupSources } from "../src/sources/materialization.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

it.each([false, true])("cleans nested mount ancestors while preserving existing parents (%j)", async (existingParent) => {
  const store = createMemoryWorkspaceStore()
  if (existingParent) await store.mkdir("shared")
  const name = crypto.randomUUID()
  registerWorkspace(name, {
    sources: { docs: custom({ files: [{ path: "file.md", content: "generated" }], materialize: "startup", mount: "shared/nested/deep" }) },
    store,
  })
  await useWorkspace(name).fs.list("")
  registerWorkspace(name, { sources: {}, store })
  await useWorkspace(name).fs.list("")
  await expect(store.stat("shared/nested")).resolves.toBeUndefined()
  if (existingParent) await expect(store.stat("shared")).resolves.toMatchObject({ type: "directory" })
  else await expect(store.stat("shared")).resolves.toBeUndefined()
})

it("reuses retained snapshots after transferring directory ownership with the Source offline", async () => {
  const store = createMemoryWorkspaceStore()
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const prepare = vi.fn(async () => {})
  const getKeys = vi.fn(async () => ["second.md"])
  registerWorkspace(first, {
    sources: { docs: custom({ files: [{ path: "first.md", content: "first" }], materialize: "startup", mount: "shared" }) },
    store,
  })
  registerWorkspace(second, {
    sources: { docs: custom({ prepare, getKeys, async getItem(key) { return { key, content: "second" } }, materialize: "startup", mount: "shared" }) },
    store,
  })
  await useWorkspace(first).fs.list("")
  await useWorkspace(second).fs.list("")
  prepare.mockClear().mockRejectedValue(new Error("Source offline"))
  getKeys.mockClear()
  registerWorkspace(first, { sources: {}, store })
  await useWorkspace(first).fs.list("")
  await expect(useWorkspace(second, { refresh: false }).fs.readFile("shared/second.md", { encoding: "utf8" })).resolves.toBe("second")
  expect(prepare).not.toHaveBeenCalled()
  expect(getKeys).not.toHaveBeenCalled()
  registerWorkspace(second, { sources: {}, store })
  await useWorkspace(second).fs.list("")
  await expect(store.stat("shared")).resolves.toBeUndefined()
})

it.each(["shared", ""])("removes shared startup directories after both Workspaces remove their Sources at mount %j", async (mount) => {
  const store = createMemoryWorkspaceStore()
  const first = `directory-owner-first-${crypto.randomUUID()}`
  const second = `directory-owner-second-${crypto.randomUUID()}`
  const path = (name: string) => [mount, "nested", name].filter(Boolean).join("/")
  const source = (name: string) => custom({
    files: [{ path: `nested/${name}`, content: name }],
    materialize: "startup",
    mount,
  })
  registerWorkspace(first, { sources: { docs: source("first.md") }, store })
  registerWorkspace(second, { sources: { docs: source("second.md") }, store })
  await useWorkspace(first).fs.list("")
  await useWorkspace(second).fs.list("")

  registerWorkspace(first, { sources: {}, store })
  await useWorkspace(first).fs.list("")
  await expect(store.stat(path("first.md"))).resolves.toBeUndefined()
  await expect(store.readFile(path("second.md"))).resolves.toMatchObject({ content: "second.md" })

  registerWorkspace(second, { sources: {}, store })
  await useWorkspace(second).fs.list("")
  await expect(store.stat(path("second.md"))).resolves.toBeUndefined()
  await expect(store.stat([mount, "nested"].filter(Boolean).join("/"))).resolves.toBeUndefined()
  if (mount) await expect(store.stat(mount)).resolves.toBeUndefined()
})

it("preserves pre-existing shared directories after both Workspaces remove their Sources", async () => {
  const store = createMemoryWorkspaceStore()
  await store.mkdir("shared/nested", { recursive: true })
  const names = [crypto.randomUUID(), crypto.randomUUID()]
  for (const name of names) {
    registerWorkspace(name, {
      sources: { docs: custom({ files: [{ path: `nested/${name}.md`, content: name }], materialize: "startup", mount: "shared" }) },
      store,
    })
    await useWorkspace(name).fs.list("")
  }
  for (const name of names) {
    registerWorkspace(name, { sources: {}, store })
    await useWorkspace(name).fs.list("")
  }
  await expect(store.stat("shared")).resolves.toMatchObject({ type: "directory" })
  await expect(store.stat("shared/nested")).resolves.toMatchObject({ type: "directory" })
  await expect(store.list("shared/nested")).resolves.toEqual([])
})

it("transfers shared directory ownership after reopening a persistent Store", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-shared-directory-"))
  const source = (name: string) => custom({
    files: [{ path: `nested/${name}.md`, content: name }],
    materialize: "startup",
    mount: "shared",
  })
  try {
    const firstStore = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources({ name: "first", sources: { docs: source("first") } }, firstStore)
    await materializeWorkspaceSources({ name: "second", sources: { docs: source("second") } }, firstStore)
    await reconcileRemovedStartupSources("first", createLocalWorkspaceStore(root), [])
    await expect(createLocalWorkspaceStore(root).stat("shared/nested/second.md")).resolves.toMatchObject({ type: "file" })
    const reopened = createLocalWorkspaceStore(root)
    await reconcileRemovedStartupSources("second", reopened, [])
    await expect(reopened.stat("shared")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})


it.each(["docs", "parent"])("preserves a user file replacing startup directory %s", async (replacement) => {
  const store = createMemoryWorkspaceStore()
  const mount = replacement === "parent" ? "parent/docs" : "docs"
  const definition = { name: "replaced-directory", sources: {
    docs: custom({ materialize: "startup", mount, files: [{ path: "file.md", content: "generated" }] }),
  } }
  await materializeWorkspaceSources(definition, store)
  await store.rm(replacement, { recursive: true })
  await store.writeFile(replacement, { path: replacement, content: "user file" })
  await reconcileRemovedStartupSources(definition.name, store, [])
  await expect(store.readFile(replacement)).resolves.toMatchObject({ content: "user file" })
})


it.each([false, true])("preserves a startup directory replaced after inspection, remove=%s", async (remove) => {
  const store = createMemoryWorkspaceStore()
  const definition = { name: "concurrent-directory", sources: {
    docs: custom({ materialize: "startup", mount: "docs", files: [{ path: "nested/file.md", content: "generated" }] }),
  } }
  await materializeWorkspaceSources(definition, store)
  const list = store.list.bind(store)
  let replaced = false
  store.list = async (path, options) => {
    const entries = await list(path, options)
    if (path === "docs/nested" && !entries.length && !replaced) {
      replaced = true
      await store.rm(path)
      await store.writeFile(path, { path, content: "concurrent replacement" })
    }
    return entries
  }
  if (remove) await reconcileRemovedStartupSources(definition.name, store, [])
  else await materializeWorkspaceSources({ ...definition, sources: {
    docs: custom({ materialize: "startup", mount: "docs", files: [] }),
  } }, store)
  expect(replaced).toBe(true)
  await expect(store.readFile("docs/nested")).resolves.toMatchObject({ content: "concurrent replacement" })
})

it("retries directory cleanup when both removal and recovery inspection fail", async () => {
  const store = createMemoryWorkspaceStore()
  const definition = { name: "directory-recovery", sources: {
    docs: custom({ materialize: "startup", mount: "docs", files: [{ path: "nested/file.md", content: "generated" }] }),
  } }
  await materializeWorkspaceSources(definition, store)
  // Reproduce legacy snapshots that reconstruct directory ownership from items.
  const key = "workspace:directory-recovery:source:docs:snapshot"
  const snapshot = await store.getMeta!(key)
  if (!snapshot || typeof snapshot !== "object") throw new Error("Missing startup snapshot")
  await store.setMeta!(key, { ...snapshot, ownedDirectories: [] })
  const empty = { ...definition, sources: { docs: custom({ materialize: "startup", mount: "docs", files: [] }) } }
  const rm = store.removeEmptyDirectory!.bind(store)
  const list = store.list.bind(store)
  let failInspection = false
  store.removeEmptyDirectory = async (path) => {
    if (path === "docs/nested") {
      failInspection = true
      throw new Error("removal unavailable")
    }
    return rm(path)
  }
  store.list = async (path, options) => {
    if (failInspection && path === "docs/nested") throw new Error("inspection unavailable")
    return list(path, options)
  }
  await expect(materializeWorkspaceSources(empty, store)).resolves.toMatchObject({ sources: [{ status: "error" }] })
  await expect(store.stat("docs/nested/file.md")).resolves.toBeUndefined()
  store.removeEmptyDirectory = rm
  store.list = list
  await expect(materializeWorkspaceSources(empty, store)).resolves.toMatchObject({ sources: [{ status: "ready" }] })
  await expect(store.stat("docs/nested")).resolves.toBeUndefined()
})
