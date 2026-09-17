import { setImmediate } from "node:timers/promises"
import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
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

it.each(cases)("retires deleted startup ownership before identical content is recreated at '$mount', volatile=$volatile", async ({ mount, volatile }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const definition: WorkspaceDefinition = {
    name: "owner",
    sources: { startup: custom({ materialize: "startup", mount, files: [{ path: "shared.md", content: "same" }] }) },
  }
  await materializeWorkspaceSources(definition, store)
  // Remove the Source, then recreate an unowned file with identical bytes.
  const empty: WorkspaceDefinition = { name: definition.name, sources: {
    startup: custom({ materialize: "startup", mount, files: [] }),
  } }
  await materializeWorkspaceSources({ name: definition.name, sources: {} }, store)
  await expect(readWorkspaceFileOwner(store, path)).resolves.toBeUndefined()
  await store.writeFile(path, { path, content: "same" })
  await materializeWorkspaceSources(empty, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "same" })
})

it.each(cases.flatMap(value => [false, true].map(refresh => ({ ...value, refresh }))))("serializes startup cleanup with another Workspace write at '$mount', volatile=$volatile, refresh=$refresh", async ({ mount, volatile, refresh }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const first: WorkspaceDefinition = { name: "first", sources: {
    startup: custom({ materialize: "startup", mount, files: [{ path: "shared.md", content: "first" }] }),
  } }
  await materializeWorkspaceSources(first, store)
  const ready = deferred()
  const write = deferred()
  const second = materializeWorkspaceSources({ name: "second", sources: {
    startup: custom({ materialize: "startup", mount, getKeys: async () => ["shared.md"], async getItem(key) {
      ready.resolve()
      await write.promise
      return { key, content: "second" }
    } }),
  } }, store)
  await ready.promise
  const removing = deferred()
  const release = deferred()
  const remove = store.rm.bind(store)
  let paused = false
  store.rm = async (target, options) => {
    if (!paused && target === path) {
      paused = true
      removing.resolve()
      await release.promise
    }
    await remove(target, options)
  }
  const cleanup = materializeWorkspaceSources({ name: "first", sources: refresh ? {
    startup: custom({ materialize: "startup", mount, files: [] }),
  } : {} }, store)
  await removing.promise
  write.resolve()
  await setImmediate()
  release.resolve()
  await Promise.all([cleanup, second])
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "second" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toMatchObject({ workspace: "second" })
})

it.each(cases.flatMap(value => [false, true].map(refresh => ({ ...value, refresh }))))("retries startup file cleanup after removal fails at '$mount', volatile=$volatile, refresh=$refresh", async ({ mount, volatile, refresh }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const definition: WorkspaceDefinition = { name: "retry-removal", sources: {
    source: custom({ materialize: "startup", mount, files: [{ path: "shared.md", content: "same" }] }),
  } }
  await materializeWorkspaceSources(definition, store)
  const remove = store.rm.bind(store)
  let fail = true
  store.rm = async (target, options) => {
    if (target === path && fail) {
      fail = false
      throw new Error("remove unavailable")
    }
    await remove(target, options)
  }
  const empty: WorkspaceDefinition = { name: definition.name, sources: refresh ? {
    source: custom({ materialize: "startup", mount, files: [] }),
  } : {} }
  if (refresh) {
    await expect(materializeWorkspaceSources(empty, store)).resolves.toMatchObject({ sources: [{ error: "remove unavailable" }] })
  }
  else {
    await expect(materializeWorkspaceSources(empty, store)).rejects.toThrow("remove unavailable")
  }
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "same" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toMatchObject({ workspace: definition.name })
  await materializeWorkspaceSources(empty, store)
  await expect(store.readFile(path)).resolves.toBeUndefined()
  await expect(readWorkspaceFileOwner(store, path)).resolves.toBeUndefined()
})

it.each(cases)("revalidates startup cleanup after mutation admission with another Workspace write at '$mount', volatile=$volatile", async ({ mount, volatile }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const first: WorkspaceDefinition = { name: "first", sources: {
    startup: custom({ materialize: "startup", mount, files: [{ path: "shared.md", content: "first" }] }),
  } }
  await materializeWorkspaceSources(first, store)
  const ready = deferred()
  const write = deferred()
  const second = materializeWorkspaceSources({ name: "second", sources: {
    startup: custom({ materialize: "startup", mount, getKeys: async () => ["shared.md"], async getItem(key) {
      ready.resolve()
      await write.promise
      return { key, content: "second" }
    } }),
  } }, store)
  await ready.promise
  await materializeWorkspaceSources({ name: "first", sources: {} }, store, {}, {
    isCurrent: () => true,
    async mutate(operation) {
      // Another Source finishes while cleanup waits for mutation admission.
      write.resolve()
      await second
      return await operation()
    },
    async checkpoint(operation) { return await operation() },
  })
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "second" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toMatchObject({ workspace: "second" })
})

it.each(["", "docs"])("preserves edits with stale inline metadata when removing startup Source at '%s'", async (mount) => {
  const store = createMemoryWorkspaceStore()
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const definition: WorkspaceDefinition = { name: "edited-inline-owner", sources: {
    startup: custom({ materialize: "startup", mount, files: [{ path: "shared.md", content: "generated" }] }),
  } }
  await materializeWorkspaceSources(definition, store)
  const file = await store.readFile(path)
  expect(file?.metadata?.source).toBe("startup")
  await store.writeFile(path, { ...file!, content: "user edit" })
  await materializeWorkspaceSources({ name: definition.name, sources: {} }, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "user edit" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toBeUndefined()
})
