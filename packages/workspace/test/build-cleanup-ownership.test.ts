import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { readWorkspaceFileOwner } from "../src/sources/file-ownership.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

const cases = ["", "docs"].flatMap(mount => [false, true].map(volatile => ({ mount, volatile })))

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function createStore(volatile: boolean): WorkspaceStore {
  const store: WorkspaceStore = createMemoryWorkspaceStore()
  const write = store.writeFile.bind(store)
  store.writeFile = (path, file) => write(path, { ...file, metadata: undefined })
  if (volatile) {
    store.getMeta = undefined
    store.setMeta = undefined
  }
  return store
}

it.each(cases)("retires deleted build ownership before identical content is recreated at '$mount', volatile=$volatile", async ({ mount, volatile }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const definition: WorkspaceDefinition = {
    name: "owner",
    sources: { build: custom({ materialize: "build", mount, files: [{ path: "shared.md", content: "same" }] }) },
  }
  await syncWorkspaceDefinition(definition, store)
  // Keep the Source configured, but remove its output on the next build.
  const empty: WorkspaceDefinition = { name: definition.name, sources: {
    build: custom({ materialize: "build", mount, files: [] }),
  } }
  await syncWorkspaceDefinition(empty, store)
  await expect(readWorkspaceFileOwner(store, path)).resolves.toBeUndefined()
  await store.writeFile(path, { path, content: "same" })
  await syncWorkspaceDefinition(empty, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "same" })
})

it.each(cases)("serializes build cleanup with another Workspace write at '$mount', volatile=$volatile", async ({ mount, volatile }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const first: WorkspaceDefinition = { name: "first", sources: {
    build: custom({ materialize: "build", mount, files: [{ path: "shared.md", content: "first" }] }),
  } }
  await syncWorkspaceDefinition(first, store)
  const ready = deferred()
  const write = deferred()
  const admitted = deferred()
  const second = syncWorkspaceDefinition({ name: "second", sources: {
    build: custom({ materialize: "build", mount, files: [] }),
  }, loaders: [{ name: "second-output", async load(ctx) {
    ready.resolve()
    await write.promise
    const pending = ctx.store.writeFile(path, { path, content: "second" })
    admitted.resolve()
    await pending
  } }] }, store)
  await ready.promise
  const inspected = deferred()
  const release = deferred()
  const remove = store.rm.bind(store)
  let paused = false
  store.rm = async (target, options) => {
    if (!paused && target === path) {
      paused = true
      inspected.resolve()
      await release.promise
    }
    await remove(target, options)
  }
  const cleanup = syncWorkspaceDefinition({ name: "first", sources: {} }, store)
  await inspected.promise
  write.resolve()
  await admitted.promise
  await setImmediate()
  release.resolve()
  await Promise.all([cleanup, second])
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "second" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toMatchObject({ workspace: "second" })
})

it("keeps build output until ownership retirement succeeds", async () => {
  const store = createStore(false)
  const definition: WorkspaceDefinition = { name: "retirement-failure", sources: {
    build: custom({ materialize: "build", mount: "", files: [{ path: "shared.md", content: "same" }] }),
  } }
  await syncWorkspaceDefinition(definition, store)
  await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "same" })
  const setMeta = store.setMeta!.bind(store)
  let fail = true
  store.setMeta = async (key, value) => {
    if (fail && key.startsWith("workspace-file-owner:") && value === null) {
      fail = false
      throw new Error("metadata unavailable")
    }
    await setMeta(key, value)
  }
  const empty = { name: definition.name, sources: {} }
  await expect(syncWorkspaceDefinition(empty, store)).rejects.toThrow("metadata unavailable")
  await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "same" })
  await syncWorkspaceDefinition(empty, store)
  await expect(store.readFile("shared.md")).resolves.toBeUndefined()
  await store.writeFile("shared.md", { path: "shared.md", content: "same" })
  await syncWorkspaceDefinition(empty, store)
  await expect(store.readFile("shared.md")).resolves.toMatchObject({ content: "same" })
})
