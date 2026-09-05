import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { blob } from "../../blob/src/runtime/storage.ts"
import { blobError } from "../../blob/src/errors.ts"
import { setBlobRuntimeConfig } from "../../blob/src/runtime/state.ts"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"
import { consoleAttachmentUpload, consoleInputMessage } from "../src/console/runtime/server/attachments.ts"

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII="
const upload = (url: string) => consoleAttachmentUpload({ method: "POST", req: { json: async () => ({ url, filename: "test.png" }) } })

it("retains image bytes and metadata across storage restart without embedding bytes in the message", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-attachments-")); dirs.push(base)
  const connect = () => {
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

  await expect(upload(`data:image/png;base64,${png}`)).rejects.toBe(cleanupError)
})

it.each([null, [], "image", {}, { url: 123 }])("rejects malformed upload bodies: %j", async (body) => {
  await expect(consoleAttachmentUpload({ method: "POST", req: { json: async () => body } }))
    .rejects.toMatchObject({ statusCode: 400, message: "An image data URL is required." })
})

it.each([[123], [null], [{}], ["../../secret"]])("rejects invalid attachment IDs: %j", async (id) => {
  await expect(consoleInputMessage("", [id])).rejects.toMatchObject({ statusCode: 400, message: "Invalid attachment ID." })
})
