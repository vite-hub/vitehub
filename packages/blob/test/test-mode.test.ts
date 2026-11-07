import { afterAll, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { blob } from "../src/runtime/storage.ts"

const mode = enableViteHubTestMode()

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
})

it("stores each store in a temporary folder that a reset empties", async () => {
  const [putError] = await blob.put("notes/a.txt", "hello")
  expect(putError).toBeNull()
  const [, archived] = await blob.store("archive").list()
  expect(archived?.blobs).toEqual([])
  const [, body] = await blob.get("notes/a.txt")
  expect(await body?.text()).toBe("hello")

  await mode.reset()

  const [, listed] = await blob.list()
  expect(listed?.blobs).toEqual([])
})
