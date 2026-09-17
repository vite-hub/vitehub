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

it.each(cases)("serializes startup cleanup with another Workspace write at '$mount', volatile=$volatile", async ({ mount, volatile }) => {
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
