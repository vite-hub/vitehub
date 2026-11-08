import { afterAll, beforeEach, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { kv } from "../src/runtime/storage.ts"
import type { ResolvedKVModuleOptions } from "../src/types.ts"

const fixture = vi.hoisted((): { config: false | ResolvedKVModuleOptions } => ({ config: false }))
vi.mock("#vitehub/kv/config", () => ({ get kv() { return fixture.config } }))

const mode = enableViteHubTestMode()
const store = { binding: "KV", driver: "cloudflare-kv-binding" } as const

beforeEach(async () => {
  await mode.reset()
  fixture.config = { store, stores: { archive: store, default: store } }
})

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
})

it("rejects disabled configuration before creating a test backend", async () => {
  fixture.config = false
  await expect(kv.get("note")).rejects.toMatchObject({ code: "KV_DISABLED" })
  expect(mode.peek("kv:default")).toBeUndefined()
})

it("rejects unknown stores before creating a test backend", async () => {
  await expect(kv.store("missing").get("note")).rejects.toMatchObject({ code: "KV_STORE_NOT_FOUND" })
  expect(mode.peek("kv:missing")).toBeUndefined()
})

it("keeps configured stores local, separate, and empty after reset", async () => {
  await expect(kv.set("note", "hello")).resolves.toEqual([undefined, undefined])
  await expect(kv.get("note")).resolves.toEqual([undefined, "hello"])
  await expect(kv.store("archive").get("note")).resolves.toEqual([undefined, null])

  await mode.reset()
  await expect(kv.get("note")).resolves.toEqual([undefined, null])
})

it("rechecks configuration when a test backend already exists", async () => {
  await kv.get("note")
  fixture.config = false
  await expect(kv.get("note")).rejects.toMatchObject({ code: "KV_DISABLED" })
})
