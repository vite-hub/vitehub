import { expect, it } from "vitest"
import { custom } from "../src/index.ts"
import { syncWorkspaceDefinition } from "../src/lifecycle.ts"
import { readWorkspaceFileOwner, recordWorkspaceFileOwner } from "../src/sources/file-ownership.ts"
import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import type { WorkspaceDefinition, WorkspaceStore } from "../src/core/types.ts"

const cases = (["build", "startup"] as const).flatMap(materialize =>
  ["", "docs"].flatMap(mount => [false, true].flatMap(volatile =>
    [false, true].map(remove => ({ materialize, mount, volatile, remove })))),
)

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

it.each(cases)("retires edited $materialize ownership at '$mount', volatile=$volatile, remove=$remove", async ({ materialize, mount, volatile, remove }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const sync = materialize === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  const definition: WorkspaceDefinition = { name: "owner", sources: {
    source: custom({ materialize, mount, files: [{ path: "shared.md", content: "original" }] }),
  } }
  await sync(definition, store)
  await store.writeFile(path, { path, content: "external edit" })
  const empty: WorkspaceDefinition = { name: definition.name, sources: remove ? {} : {
    source: custom({ materialize, mount, files: [] }),
  } }
  await sync(empty, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "external edit" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toBeUndefined()
  // Restoring the old bytes cannot restore cleanup authority.
  await store.writeFile(path, { path, content: "original" })
  await sync({ name: definition.name, sources: {
    source: custom({ materialize, mount, files: [] }),
  } }, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "original" })
})

it.each(cases.flatMap(value => ["workspace", "source"].map(other => ({ ...value, other }))))("preserves another $other owner during $materialize cleanup at '$mount', volatile=$volatile, remove=$remove", async ({ materialize, mount, volatile, remove, other }) => {
  const store = createStore(volatile)
  const path = [mount, "shared.md"].filter(Boolean).join("/")
  const sync = materialize === "build" ? syncWorkspaceDefinition : materializeWorkspaceSources
  const definition: WorkspaceDefinition = { name: "owner", sources: {
    source: custom({ materialize, mount, files: [{ path: "shared.md", content: "original" }] }),
  } }
  await sync(definition, store)
  const originalOwner = await readWorkspaceFileOwner(store, path)
  expect(originalOwner).toBeDefined()
  const replacement = {
    workspace: other === "workspace" ? "another-workspace" : definition.name,
    source: other === "source" ? "another-source" : originalOwner!.source,
    digest: originalOwner!.digest,
  }
  await store.writeFile(path, { path, content: "external edit" })
  await recordWorkspaceFileOwner(store, path, replacement)
  await sync({ name: definition.name, sources: remove ? {} : {
    source: custom({ materialize, mount, files: [] }),
  } }, store)
  await expect(store.readFile(path)).resolves.toMatchObject({ content: "external edit" })
  await expect(readWorkspaceFileOwner(store, path)).resolves.toEqual(replacement)
})
