import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { blob } from "../../blob/src/runtime/storage.ts"
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
    installConsoleBlob(base, blob)
  }
  connect()
  const attachment = await upload(`data:image/png;base64,${png}`)
  connect()
  const message = await consoleInputMessage("", [attachment.id])
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
  await expect(consoleInputMessage("", ["../../secret"])).rejects.toMatchObject({ statusCode: 400 })
})
