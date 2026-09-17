import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { materializeWorkspaceSources, reconcileRemovedStartupSources } from "../src/sources/materialization.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const snapshotKey = "workspace:retirement:source:docs:snapshot"

it.each([false, true].flatMap(refresh => [false, true].map(reopen => ({ refresh, reopen }))))("preserves recreated startup directories after snapshot cleanup fails, refresh=$refresh, reopen=$reopen", async ({ refresh, reopen }) => {
  const root = await mkdtemp(join(tmpdir(), "startup-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources({ name: "retirement", sources: {
      docs: custom({ materialize: "startup", mount: "docs", files: refresh ? [{ path: "nested/file.md", content: "generated" }] : [] }),
    } }, store)
    const remove = store.removeEmptyDirectory!.bind(store)
    const setMeta = store.setMeta!.bind(store)
    let removed = false
    store.removeEmptyDirectory = async (path) => {
      await remove(path)
      removed = true
    }
    store.setMeta = async (key, value) => {
      if (removed && key === snapshotKey) throw new Error("metadata unavailable")
      await setMeta(key, value)
    }
    const cleanup = (target: typeof store) => refresh
      ? materializeWorkspaceSources({ name: "retirement", sources: { docs: custom({ materialize: "startup", mount: "docs", files: [] }) } }, target)
      : reconcileRemovedStartupSources("retirement", target, [])
    await expect(cleanup(store)).rejects.toThrow("metadata unavailable")
    expect(removed).toBe(true)
    const recreated = refresh ? "docs/nested" : "docs"
    await store.mkdir(recreated, { recursive: true })
    store.setMeta = setMeta
    const retry = reopen ? createLocalWorkspaceStore(root) : store
    await cleanup(retry)
    await expect(retry.stat(recreated)).resolves.toMatchObject({ type: "directory" })
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.meta.json`, { force: true })
  }
})

it("preserves startup directories when retirement metadata fails before removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "startup-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources({ name: "retirement", sources: {
      docs: custom({ materialize: "startup", mount: "docs", files: [] }),
    } }, store)
    const setMeta = store.setMeta!.bind(store)
    store.setMeta = async (key, value) => {
      if (key === snapshotKey) throw new Error("metadata unavailable")
      await setMeta(key, value)
    }
    await expect(reconcileRemovedStartupSources("retirement", store, [])).rejects.toThrow("metadata unavailable")
    await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
    const reopened = createLocalWorkspaceStore(root)
    await reconcileRemovedStartupSources("retirement", reopened, [])
    await expect(reopened.stat("docs")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.meta.json`, { force: true })
  }
})

it.each([false, true])("restores failed startup removal without reviving completed removals, recreate=%s", async (recreate) => {
  const root = await mkdtemp(join(tmpdir(), "startup-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources({ name: "retirement", sources: {
      docs: custom({ materialize: "startup", mount: "parent/docs", files: [] }),
    } }, store)
    const remove = store.removeEmptyDirectory!.bind(store)
    store.removeEmptyDirectory = async (path) => {
      if (path === "parent") throw new Error("removal unavailable")
      await remove(path)
    }
    await expect(reconcileRemovedStartupSources("retirement", store, [])).rejects.toThrow("removal unavailable")
    if (recreate) await store.mkdir("parent/docs")
    const reopened = createLocalWorkspaceStore(root)
    await reconcileRemovedStartupSources("retirement", reopened, [])
    if (recreate) await expect(reopened.stat("parent/docs")).resolves.toMatchObject({ type: "directory" })
    else await expect(reopened.stat("parent")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.meta.json`, { force: true })
  }
})

it("retries refresh directory cleanup after its retirement checkpoint fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "startup-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources({ name: "retirement", sources: {
      docs: custom({ materialize: "startup", mount: "docs", files: [{ path: "nested/file.md", content: "generated" }] }),
    } }, store)
    const setMeta = store.setMeta!.bind(store)
    let failed = false
    store.setMeta = async (key, value) => {
      if (!failed && key === snapshotKey
        && !await store.stat("docs/nested/file.md") && await store.stat("docs/nested")) {
        failed = true
        throw new Error("retirement unavailable")
      }
      await setMeta(key, value)
    }
    const empty = { name: "retirement", sources: { docs: custom({ materialize: "startup", mount: "docs", files: [] }) } }
    await expect(materializeWorkspaceSources(empty, store)).resolves.toMatchObject({ sources: [{ status: "error", error: "retirement unavailable" }] })
    expect(failed).toBe(true)
    await expect(store.stat("docs/nested")).resolves.toMatchObject({ type: "directory" })
    const reopened = createLocalWorkspaceStore(root)
    await expect(materializeWorkspaceSources(empty, reopened)).resolves.toMatchObject({ sources: [{ status: "ready" }] })
    await expect(reopened.stat("docs/nested")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.meta.json`, { force: true })
  }
})
