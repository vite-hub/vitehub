import { afterEach, expect, it, vi } from "vitest"

import { sharedRuntimeKey } from "../src/runtime/shared-runtime.ts"

afterEach(() => {
  vi.resetModules()
  vi.doUnmock("#vitehub/database/databases")
  Reflect.deleteProperty(globalThis, sharedRuntimeKey)
})

// In `vite dev`, Vite loads the registry with the app's Databases, and Node loads a second copy for Agent, which has the
// package's empty fallback registry.
async function loadCopy(databases: () => Promise<unknown>) {
  vi.resetModules()
  vi.doMock("#vitehub/database/databases", databases)
  const registry = await import("../src/runtime/registry.ts")
  // SAFETY: The test app has no generated registry types, so look the Database up by its runtime name, as Agent does.
  return { useDatabase: registry.useDatabase as unknown as (name: string) => { db: unknown } }
}

const appDb = { name: "the app's Database" }
const appCopy = () => loadCopy(async () => ({ default: { default: { db: appDb, relations: {}, schema: {} } } }))
const nodeCopy = () => loadCopy(() => import("../src/runtime/virtual-databases.ts"))

it("gives the copy without Databases the Databases of the app's copy", async () => {
  const node = await nodeCopy()
  expect(() => node.useDatabase("default")).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND" }))

  const app = await appCopy()
  expect(app.useDatabase("default").db).toBe(appDb)
  expect(node.useDatabase("default").db).toBe(appDb)
})

it("keeps the Databases of a copy that has its own", async () => {
  await appCopy()
  const other = { name: "another build's Database" }
  const own = await loadCopy(async () => ({ default: { default: { db: other, relations: {}, schema: {} } } }))
  expect(own.useDatabase("default").db).toBe(other)
})
