import { afterAll, beforeEach, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"

const mode = enableViteHubTestMode()
const store = { binding: "BLOB", driver: "cloudflare-r2" } as const

beforeEach(async () => {
  await mode.reset()
  setBlobRuntimeConfig({ store, stores: { archive: store, default: store } })
})

afterAll(async () => {
  await mode.reset()
  setBlobRuntimeConfig(undefined)
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
})

it("reports disabled configuration before creating a test backend", async () => {
  setBlobRuntimeConfig(false)
  const [error] = await blob.get("note.txt")
  expect(error).toMatchObject({ cause: { code: "BLOB_R0023" }, code: "BLOB_OPERATION_FAILED" })
  expect(mode.peek("blob:default")).toBeUndefined()
})

it("rejects unknown stores before creating a test backend", async () => {
  await expect(blob.store("missing").get("note.txt")).rejects.toMatchObject({ code: "BLOB_R0027" })
  expect(mode.peek("blob:missing")).toBeUndefined()
})

it("rechecks configuration when a test backend already exists", async () => {
  await blob.get("note.txt")
  setBlobRuntimeConfig(false)
  const [error] = await blob.get("note.txt")
  expect(error).toMatchObject({ cause: { code: "BLOB_R0023" }, code: "BLOB_OPERATION_FAILED" })
})

it("stores each store in a temporary folder that a reset empties", async () => {
  const [putError] = await blob.put("notes/a.txt", "hello")
  expect(putError).toBeUndefined()
  const [, archived] = await blob.store("archive").list()
  expect(archived?.blobs).toEqual([])
  const [, body] = await blob.get("notes/a.txt")
  expect(await body?.text()).toBe("hello")

  await mode.reset()

  const [, listed] = await blob.list()
  expect(listed?.blobs).toEqual([])
})
