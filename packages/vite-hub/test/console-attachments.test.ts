import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { blob } from "../../blob/src/runtime/storage.ts"
import { setBlobRuntimeConfig, setBlobRuntimeStorage } from "../../blob/src/runtime/state.ts"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"
import { consoleAttachmentUpload, consoleInputMessage } from "../src/console/runtime/server/attachments.ts"

import { defineAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"

const root = "/console-attachment-permissions-test"
function installInvocationAccess(invoke: boolean) {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const definition = defineAgent({ name: "images", invocations, runtime: false, driver: { run: () => "Done" } })
  installConsoleAgentDefinitions([{ definition, fallbackName: "images" }], { projectRoot: root, invoke })
}
beforeEach(() => installInvocationAccess(true))

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); setBlobRuntimeStorage(undefined); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII="
const upload = (url: string) => consoleAttachmentUpload({ method: "POST", req: { json: async () => ({ url, filename: "test.png" }) } })

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

it.each([null, [], "image", {}, { url: 123 }])("rejects malformed upload bodies: %j", async (body) => {
  await expect(consoleAttachmentUpload({ method: "POST", req: { json: async () => body } }))
    .rejects.toMatchObject({ statusCode: 400, message: "An image data URL is required." })
})

it.each([[123], [null], [{}], ["../../secret"]])("rejects invalid attachment IDs: %j", async (id) => {
  await expect(consoleInputMessage("", [id])).rejects.toMatchObject({ statusCode: 400, message: "Invalid attachment ID." })
})


it("disables uploads when Console invocation is disabled", async () => {
  installInvocationAccess(false)
  const put = vi.spyOn(blob, "put")
  await expect(upload(`data:image/png;base64,${png}`)).rejects.toMatchObject({ statusCode: 404 })
  expect(put).not.toHaveBeenCalled()
})

it("rejects malformed base64 before storing an image", async () => {
  const put = vi.spyOn(blob, "put")
  await expect(upload("data:image/png;base64,YQ")).rejects.toMatchObject({ statusCode: 400 })
  expect(put).not.toHaveBeenCalled()
})

it("removes uploads that cannot produce a usable serving URL", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-upload-cleanup-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base } })
  installConsoleBlob(base, blob)
  await expect(upload(`data:image/png;base64,${png}`)).rejects.toMatchObject({ statusCode: 503 })
  const [failure, listing] = await blob.list()
  expect(failure).toBeNull()
  expect(listing?.blobs).toEqual([])
})
