import { expect, it, vi } from "vitest"

import { materializeWorkspaceSources } from "../src/sources/materialization.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

it("reuses fresh startup snapshots in Stores without file attributes", async () => {
  const backing = createMemoryWorkspaceStore()
  const writeFile = backing.writeFile.bind(backing)
  vi.spyOn(backing, "writeFile").mockImplementation(async (path, file) => {
    await writeFile(path, { path: file.path, content: file.content })
  })
  const store = backing
  const getItem = vi.fn(async (key: string) => ({ key, content: "original", mediaType: "text/plain", metadata: { mode: "first" } }))
  const definition = { name: "no-file-attributes", sources: { docs: {
    cache: { maxAge: 3600 }, materialize: "startup" as const, mount: "",
    async getKeys() { return ["file.txt"] }, getItem,
  } } }

  expect((await materializeWorkspaceSources(definition, store)).sources[0]).toMatchObject({ status: "ready" })
  await materializeWorkspaceSources(definition, store)
  expect(getItem).toHaveBeenCalledTimes(1)

  await backing.writeFile("file.txt", { path: "file.txt", content: "changed locally" })
  await materializeWorkspaceSources(definition, store)
  expect(getItem).toHaveBeenCalledTimes(2)
  await expect(store.readFile("file.txt")).resolves.toMatchObject({ content: "original" })
})

it("reports upstream attribute changes when the Store cannot expose file attributes", async () => {
  const backing = createMemoryWorkspaceStore()
  const writeFile = backing.writeFile.bind(backing)
  vi.spyOn(backing, "writeFile").mockImplementation(async (path, file) => {
    await writeFile(path, { path: file.path, content: file.content })
  })
  const store = backing
  let mode = "first"
  const definition = { name: "no-file-attributes", sources: { docs: {
    cache: false as const, materialize: "startup" as const, mount: "",
    async getKeys() { return ["file.txt"] },
    async getItem(key: string) { return { key, content: "original", metadata: { mode } } },
  } } }
  await materializeWorkspaceSources(definition, store)
  mode = "second"
  const result = await materializeWorkspaceSources(definition, store)
  expect(result.sources[0]).toMatchObject({ status: "ready" })
  expect(result.sources[0]?.counts).toMatchObject({ updated: 1, unchanged: 0 })
})
