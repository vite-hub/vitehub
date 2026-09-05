import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { blob } from "../../blob/src/runtime/storage.ts"
import { blobError } from "../../blob/src/errors.ts"
import { setBlobRuntimeConfig, setBlobRuntimeStorage } from "../../blob/src/runtime/state.ts"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"
import { consoleInputMessage, storeConsoleInputMessage, withConsoleInputMessage } from "../src/console/runtime/server/attachments.ts"

const dirs: string[] = []
afterEach(async () => {
  setBlobRuntimeStorage(undefined)
  setBlobRuntimeConfig(undefined)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII="
const uploadBatch = async (files: Array<{ url: string, filename?: string }>) => (await storeConsoleInputMessage("", { files })).parts.filter(part => part.type === "image")
const upload = async (url: string) => (await uploadBatch([{ url, filename: "test.png" }]))[0]!

it("retains image bytes and metadata across storage restart without embedding bytes in the message", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  const connect = () => {
    setBlobRuntimeStorage(undefined)
    setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
    installConsoleBlob(base, {
      ...blob,
      put(path, bytes, options) {
        if (options?.customMetadata && Object.keys(options.customMetadata).length) throw new Error("Provider does not support custom metadata")
        return blob.put(path, bytes, options)
      },
    })
  }
  connect()
  const attachment = await upload(`data:image/png;base64,${png}`)
  connect()
  const message = await consoleInputMessage("", [{ id: attachment.id, name: attachment.name }])
  const part = message.parts[0]
  expect(part).toMatchObject({ type: "image", id: attachment.id, mediaType: "image/png", name: "test.png" })
  expect(JSON.stringify(message)).not.toContain(png)
  if (part?.type !== "image") throw new Error("Expected image")
  const bytes = await part.fetchData!()
  expect(bytes).toBeInstanceOf(Blob)
  expect(Buffer.from(await (bytes as Blob).arrayBuffer()).toString("base64")).toBe(png)
})

it("rejects remote URLs, unsupported files, missing images, and path traversal", async () => {
  await expect(upload("https://example.test/image.png")).rejects.toMatchObject({ statusCode: 415 })
  await expect(upload("data:text/html;base64,PHNjcmlwdD4=")).rejects.toMatchObject({ statusCode: 415 })
  await expect(consoleInputMessage("", [{ id: "../../secret", name: "secret" }])).rejects.toMatchObject({ statusCode: 400 })
})

it("removes a rejected upload when Blob serving is not configured", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base } })
  installConsoleBlob(base, blob)

  await expect(upload(`data:image/png;base64,${png}`)).rejects.toMatchObject({ statusCode: 503 })
  const [failure, result] = await blob.list({ prefix: "vitehub-console-attachments/" })
  expect(failure).toBeNull()
  expect(result?.blobs).toEqual([])
})

it("surfaces a rejected upload's cleanup failure", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base } })
  const cleanupError = blobError("BLOB_OPERATION_FAILED", "del", "default")
  installConsoleBlob(base, {
    ...blob,
    async del() { return [cleanupError, undefined] },
  })

  await expect(upload(`data:image/png;base64,${png}`)).rejects.toMatchObject({ errors: [expect.objectContaining({ statusCode: 503 }), cleanupError] })
  const [, pending] = await blob.list({ prefix: "vitehub-console-attachments/" })
  const id = pending!.blobs[0]!.pathname.split("/")[1]!
  await expect(consoleInputMessage("retry", [{ id, name: "image" }])).rejects.toMatchObject({ statusCode: 404, message: "The stored image is pending deletion." })
})

it.each([null, [], "image", {}, { url: 123 }])("rejects malformed upload bodies: %j", async (body) => {
  await expect(storeConsoleInputMessage("", body))
    .rejects.toMatchObject({ statusCode: 400, message: "Provide between 1 and 10 image data URLs." })
})

it.each([[123], [null], [{}], ["../../secret"]])("rejects invalid attachment IDs: %j", async (id) => {
  await expect(consoleInputMessage("", [id])).rejects.toMatchObject({ statusCode: 400, message: "Invalid attachment ID." })
})

it("validates all files and the combined budget before writing any objects", async () => {
  const put = vi.fn(blob.put)
  installConsoleBlob("/batch-validation", { ...blob, put })
  const file = { url: `data:image/png;base64,${png}` }
  await expect(uploadBatch([file, { url: "data:text/html;base64,PHNjcmlwdD4=" }])).rejects.toMatchObject({ statusCode: 415 })
  await expect(uploadBatch(Array.from({ length: 11 }, () => file))).rejects.toMatchObject({ statusCode: 400 })
  await expect(uploadBatch([])).rejects.toMatchObject({ statusCode: 400 })
  const large = { url: `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024).toString("base64")}` }
  await expect(uploadBatch([large, large])).rejects.toMatchObject({ statusCode: 413 })
  expect(put).not.toHaveBeenCalled()
})

it("rolls back a partially written batch without deleting an earlier successful upload", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  installConsoleBlob(base, blob)
  const retained = await upload(`data:image/png;base64,${png}`)
  const failure = blobError("BLOB_OPERATION_FAILED", "put", "default")
  let writes = 0
  installConsoleBlob(base, {
    ...blob,
    async put(path, bytes, options) {
      const result = await blob.put(path, bytes, options)
      // Simulate a provider error after the second object's bytes were written.
      if (++writes === 2) return [failure, undefined]
      return result
    },
  })
  await expect(uploadBatch([{ url: `data:image/png;base64,${png}` }, { url: `data:image/png;base64,${png}` }])).rejects.toBe(failure)
  const [listError, result] = await blob.list({ prefix: "vitehub-console-attachments/" })
  expect(listError).toBeNull()
  expect(result?.blobs.map(item => item.pathname)).toEqual([`vitehub-console-attachments/${retained.id}`])
})

it("attempts every rollback even when one deletion fails", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  const failure = new Error("Upload interrupted")
  const cleanupError = blobError("BLOB_OPERATION_FAILED", "del", "default")
  let writes = 0
  let deletions = 0
  const del = vi.fn(async (path: string | string[]) => {
    if (++deletions === 1) throw cleanupError
    return blob.del(path)
  })
  installConsoleBlob(base, {
    ...blob,
    del,
    async put(path, bytes, options) {
      if (++writes === 2) throw failure
      return blob.put(path, bytes, options)
    },
  })
  await expect(uploadBatch([{ url: `data:image/png;base64,${png}` }, { url: `data:image/png;base64,${png}` }])).rejects.toMatchObject({ errors: [failure, cleanupError] })
  expect(del.mock.calls.filter(([path]) => typeof path === "string" && path.startsWith("vitehub-console-attachments/"))).toHaveLength(2)
})

it("returns durable references for every file in a successful batch", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  installConsoleBlob(base, blob)
  const parts = await uploadBatch([
    { url: `data:image/png;base64,${png}`, filename: "first.png" },
    { url: `data:image/png;base64,${png}`, filename: "second.png" },
  ])
  expect(parts.map(part => part.name)).toEqual(["first.png", "second.png"])
  expect(new Set(parts.map(part => part.id)).size).toBe(2)
  setBlobRuntimeStorage(undefined)
  const message = await consoleInputMessage("both images", parts)
  expect(message.parts.map(part => part.type)).toEqual(["text", "image", "image"])
  for (const part of message.parts) {
    if (part.type === "image") expect(await part.fetchData!()).toBeInstanceOf(Blob)
  }
})

it.each([false, true])("rolls back a new input batch when reconstruction fails, cleanup failure: %s", async (failCleanup) => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  installConsoleBlob(base, blob)
  const retained = await upload(`data:image/png;base64,${png}`)
  const failure = blobError("BLOB_OPERATION_FAILED", "head", "default")
  const cleanupError = blobError("BLOB_OPERATION_FAILED", "del", "default")
  let reads = 0
  let deletions = 0
  installConsoleBlob(base, {
    ...blob,
    async head(path) {
      if (++reads === 2) return [failure, undefined]
      return blob.head(path)
    },
    async del(path) {
      if (typeof path === "string" && path.startsWith("vitehub-console-attachments/") && ++deletions === 1 && failCleanup) return [cleanupError, undefined]
      return blob.del(path)
    },
  })
  const input = storeConsoleInputMessage("test", { files: [
    { url: `data:image/png;base64,${png}` },
    { url: `data:image/png;base64,${png}` },
  ] })
  if (failCleanup) await expect(input).rejects.toMatchObject({ errors: [failure, cleanupError] })
  else await expect(input).rejects.toBe(failure)
  expect(deletions).toBe(2)
  const [listError, result] = await blob.list({ prefix: "vitehub-console-attachments/" })
  expect(listError).toBeNull()
  expect(result?.blobs).toHaveLength(failCleanup ? 2 : 1)
  expect(result?.blobs.map(item => item.pathname)).toContain(`vitehub-console-attachments/${retained.id}`)
})

it.each([false, true])("only rolls back startup failures before runtime handoff: %s", async (handedOff) => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  installConsoleBlob(base, blob)
  const retained = await upload(`data:image/png;base64,${png}`)
  const failure = new Error("Agent startup failed")
  await expect(withConsoleInputMessage("test", { files: [{ url: `data:image/png;base64,${png}` }] }, async (_message, handoff) => {
    if (handedOff) handoff()
    throw failure
  })).rejects.toBe(failure)
  const [listError, result] = await blob.list({ prefix: "vitehub-console-attachments/" })
  expect(listError).toBeNull()
  expect(result?.blobs).toHaveLength(handedOff ? 2 : 1)
  expect(result?.blobs.map(item => item.pathname)).toContain(`vitehub-console-attachments/${retained.id}`)
})
