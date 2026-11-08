import { H3Event } from "h3"
import sharp from "sharp"
import { afterAll, beforeEach, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"

const mode = enableViteHubTestMode()
const store = { binding: "BLOB", driver: "cloudflare" } as const

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

it.each([false as const, { transformer: "passthrough" as const }])("preserves image configuration %j when serving variants", async (images) => {
  setBlobRuntimeConfig({ images, store, stores: { archive: store, default: store } })
  const bytes = await sharp({ create: { background: "red", channels: 3, height: 200, width: 300 } }).jpeg().toBuffer()

  for (const name of ["default", "archive"]) {
    const storage = blob.store(name)
    const [putError] = await storage.media.put("photo.jpg", bytes)
    expect(putError).toBeUndefined()
    const event = new H3Event(new Request("https://example.test/photo.jpg"))
    const [error, body] = await storage.serve(event, "photo.jpg", { variant: { format: "webp", width: 64 } })
    expect(error).toBeUndefined()
    expect(event.res.headers.get("content-type")).toBe("image/jpeg")
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array(bytes))
  }
})

it("preserves custom image sizes, quality, and transformer for every test store", async () => {
  setBlobRuntimeConfig({ images: { quality: 42, sizes: [80, 160], transformer: "photon" }, store, stores: { archive: store, default: store } })
  const bytes = await sharp({ create: { background: "red", channels: 3, height: 200, width: 300 } }).jpeg().toBuffer()

  for (const name of ["default", "archive"]) {
    const storage = blob.store(name)
    const [putError] = await storage.media.put("photo.jpg", bytes)
    expect(putError).toBeUndefined()
    const event = new H3Event(new Request("https://example.test/photo.jpg"))
    const [error, body] = await storage.serve(event, "photo.jpg", { variant: { width: 70 } })
    expect(error).toBeUndefined()
    expect(await sharp(new Uint8Array(await new Response(body).arrayBuffer())).metadata()).toMatchObject({ format: "webp", width: 80 })
    const [variantsError, variants] = await storage.media.variants("photo.jpg")
    expect(variantsError).toBeUndefined()
    expect(variants?.[0]?.key).toContain("q=42;engine=photon")
  }
})
