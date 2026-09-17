import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

it.each(["workspace:build-directory-users", "workspace:retirement:build-directories"].flatMap(key => [false, true].map(reopen => ({ key, reopen }))))("preserves recreated directories after $key retirement fails, reopen=$reopen", async ({ key, reopen }) => {
  const root = await mkdtemp(join(tmpdir(), "build-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition({ name: "retirement", sources: {
      docs: custom({ materialize: "build", mount: "docs", files: [] }),
    } }, store)
    const remove = store.removeEmptyDirectory!.bind(store)
    const setMeta = store.setMeta!.bind(store)
    let removed = false
    store.removeEmptyDirectory = async (path) => {
      await remove(path)
      removed = true
    }
    store.setMeta = async (name, value) => {
      if (removed && name === key) throw new Error("metadata unavailable")
      await setMeta(name, value)
    }
    const empty = { name: "retirement", sources: {} }
    await expect(syncWorkspaceDefinition(empty, store)).rejects.toThrow("metadata unavailable")
    expect(removed).toBe(true)
    await store.mkdir("docs")
    store.setMeta = setMeta
    const retry = reopen ? createLocalWorkspaceStore(root) : store
    await syncWorkspaceDefinition(empty, retry)
    await expect(retry.stat("docs")).resolves.toMatchObject({ type: "directory" })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["workspace:build-directory-users", "workspace:retirement:build-directories"])("preserves the directory when retiring %s fails before removal", async (key) => {
  const root = await mkdtemp(join(tmpdir(), "build-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition({ name: "retirement", sources: {
      docs: custom({ materialize: "build", mount: "docs", files: [] }),
    } }, store)
    const setMeta = store.setMeta!.bind(store)
    store.setMeta = async (name, value) => {
      if (name === key) throw new Error("metadata unavailable")
      await setMeta(name, value)
    }
    await expect(syncWorkspaceDefinition({ name: "retirement", sources: {} }, store)).rejects.toThrow("metadata unavailable")
    await expect(store.stat("docs")).resolves.toMatchObject({ type: "directory" })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("retains failed removal authority across Store reopen without reviving completed removals", async () => {
  const root = await mkdtemp(join(tmpdir(), "build-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition({ name: "retirement", sources: {
      docs: custom({ materialize: "build", mount: "parent/docs", files: [] }),
    } }, store)
    const remove = store.removeEmptyDirectory!.bind(store)
    store.removeEmptyDirectory = async (path) => {
      if (path === "parent") throw new Error("removal unavailable")
      await remove(path)
    }
    const empty = { name: "retirement", sources: {} }
    await expect(syncWorkspaceDefinition(empty, store)).rejects.toThrow("removal unavailable")
    await store.mkdir("parent/docs")
    const reopened = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition(empty, reopened)
    await expect(reopened.stat("parent/docs")).resolves.toMatchObject({ type: "directory" })
    await reopened.rm("parent/docs")
    await syncWorkspaceDefinition(empty, reopened)
    await expect(reopened.stat("parent")).resolves.toBeUndefined()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("does not revive a relinquished shared claim after a sibling removal and metadata failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "build-directory-retirement-"))
  try {
    const store = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition({ name: "first", sources: {
      shared: custom({ materialize: "build", mount: "shared-directory", files: [] }),
      sibling: custom({ materialize: "build", mount: "docs", files: [] }),
    } }, store)
    await syncWorkspaceDefinition({ name: "second", sources: {
      shared: custom({ materialize: "build", mount: "shared-directory", files: [] }),
    } }, store)
    const remove = store.removeEmptyDirectory!.bind(store)
    const setMeta = store.setMeta!.bind(store)
    let removed = false
    store.removeEmptyDirectory = async (path) => {
      await remove(path)
      removed = true
    }
    store.setMeta = async (key, value) => {
      if (removed && key === "workspace:first:build-directories") throw new Error("metadata unavailable")
      await setMeta(key, value)
    }
    await expect(syncWorkspaceDefinition({ name: "first", sources: {} }, store)).rejects.toThrow("metadata unavailable")
    expect(removed).toBe(true)

    const reopened = createLocalWorkspaceStore(root)
    await syncWorkspaceDefinition({ name: "second", sources: {} }, reopened)
    await expect(reopened.stat("shared-directory")).resolves.toBeUndefined()
    await reopened.mkdir("shared-directory")
    await syncWorkspaceDefinition({ name: "first", sources: {} }, reopened)
    await expect(reopened.stat("shared-directory")).resolves.toMatchObject({ type: "directory" })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
