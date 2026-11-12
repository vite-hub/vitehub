import { afterEach, expect, it, vi } from "vitest"

import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"

// The R2 HTTP driver fails to load once, as an import can fail during a development rebuild.
const r2 = vi.hoisted(() => ({ failures: 1 }))

vi.mock("../src/drivers/cloudflare.ts", () => {
  if (r2.failures > 0) {
    r2.failures--
    throw new Error("transient R2 driver import failure")
  }
  return { createDriver: () => ({ get: async () => null }) }
})

afterEach(() => {
  setBlobRuntimeConfig(undefined)
})

it("loads the R2 HTTP driver again on the next call after a failed load", async () => {
  const store = { binding: "BLOB", driver: "cloudflare-r2" } as const
  setBlobRuntimeConfig({ store, stores: { default: store } })

  const [failure] = await blob.get("note.txt")
  expect(failure).toMatchObject({ code: "BLOB_OPERATION_FAILED" })
  const [error, body] = await blob.get("note.txt")
  expect(error).toBeUndefined()
  expect(body).toBeNull()
})
