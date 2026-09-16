import { afterEach, expect, it, vi } from "vitest"
import { custom, defineWorkspace } from "../src/index.ts"
import { resetWorkspaceRegistry, useRegisteredWorkspace } from "../src/core/registry.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"
import { registerWorkspace } from "../src/test.ts"

afterEach(() => {
  resetWorkspaceRegistry()
  vi.restoreAllMocks()
})

it.each([
  ["generated", "refresh"],
  ["generated", "retirement"],
  ["generated/nested", "refresh"],
  ["generated/nested", "retirement"],
])("preserves concurrent user directory %s after %s", async (directory, operation) => {
  const store = createMemoryWorkspaceStore()
  let keys = ["nested/file.md"]
  const sources = { generated: custom({
    materialize: "startup",
    async getKeys() { return keys },
    async getItem(key) { return { key, content: key } },
  }) }
  const mkdir = store.mkdir.bind(store)
  const stat = store.stat.bind(store)
  let userCreated = false
  const createUserDirectory = async () => {
    userCreated = true
    await mkdir(directory, { recursive: true })
  }
  // Exercise the old stat/mutation gap as well as creation with onCreate.
  vi.spyOn(store, "stat").mockImplementation(async (path) => {
    const result = await stat(path)
    if (path === directory && !result && !userCreated) await createUserDirectory()
    return result
  })
  vi.spyOn(store, "mkdir").mockImplementation(async (path, options) => {
    if (path === directory && !userCreated) await createUserDirectory()
    await mkdir(path, options)
  })
  registerWorkspace("directory-creation-race", defineWorkspace({ store, sources }))
  const workspace = await useRegisteredWorkspace("directory-creation-race")
  await workspace.materializeSources?.()
  expect(userCreated).toBe(true)
  expect(await store.readFile("generated/nested/file.md")).toBeDefined()
  if (operation === "retirement") Reflect.deleteProperty(sources, "generated")
  else keys = []
  await workspace.materializeSources?.()
  expect(await store.readFile("generated/nested/file.md")).toBeUndefined()
  expect(await stat(directory)).toEqual(expect.objectContaining({ type: "directory" }))
})
