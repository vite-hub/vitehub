import { afterEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import { blobDocument } from "../src/server.ts"
import { appendParagraph, createStubEditor, createTestServer, settle } from "./harness.ts"

import type { RealtimeBlobStore } from "../src/server.ts"

function memoryBlob() {
  const files = new Map<string, { body: string, contentType: string }>()
  const store: RealtimeBlobStore = {
    async get(pathname) {
      const file = files.get(pathname)
      return [null, file ? new Blob([file.body], { type: file.contentType }) : null]
    },
    async put(pathname, body, { contentType }) {
      files.set(pathname, { body, contentType })
      return [null, { pathname }]
    },
  }
  return { files, store }
}

const context = { authority: "memory", definition: "drafts", documentId: "a/v1.md" } as const
const save = { editors: [], reason: "idle" as const }

describe("blobDocument", () => {
  it("creates, loads, and saves one private Markdown file per document", async () => {
    const { files, store } = memoryBlob()
    const adapter = blobDocument(store, { prefix: "drafts/" })
    expect(await adapter.load(context)).toEqual({ body: "", digest: null })

    const created = await adapter.save(context, { body: "# One" }, { ...save, ifDigest: null })
    expect(files.get("drafts/a/v1.md")).toEqual({ body: "# One", contentType: "text/markdown; charset=utf-8" })
    expect(await adapter.load(context)).toEqual({ body: "# One", digest: created.digest })

    const edited = await adapter.save(context, { body: "# Two" }, { ...save, ifDigest: created.digest })
    expect(edited.digest).not.toBe(created.digest)
    expect(files.get("drafts/a/v1.md")?.body).toBe("# Two")
  })

  it("throws RealtimeDocumentConflict and keeps the other writer's file", async () => {
    const { files, store } = memoryBlob()
    const adapter = blobDocument(store)
    await store.put(context.documentId, "# Draft", { access: "private", contentType: "text/markdown" })
    const loaded = await adapter.load(context)
    await store.put(context.documentId, "# Someone else", { access: "private", contentType: "text/markdown" })

    await expect(adapter.save(context, { body: "# Room" }, { ...save, ifDigest: loaded.digest }))
      .rejects.toMatchObject({ code: "REALTIME_DOCUMENT_CONFLICT", name: "RealtimeDocumentConflict" })
    expect(files.get(context.documentId)?.body).toBe("# Someone else")
  })

  it("throws RealtimeDocumentConflict when the file was deleted or created by someone else", async () => {
    const { files, store } = memoryBlob()
    const adapter = blobDocument(store)
    await store.put(context.documentId, "# Draft", { access: "private", contentType: "text/markdown" })
    const loaded = await adapter.load(context)
    files.delete(context.documentId)
    await expect(adapter.save(context, { body: "# Room" }, { ...save, ifDigest: loaded.digest }))
      .rejects.toMatchObject({ code: "REALTIME_DOCUMENT_CONFLICT" })
    expect(files.has(context.documentId)).toBe(false)

    await store.put(context.documentId, "# New", { access: "private", contentType: "text/markdown" })
    await expect(adapter.save(context, { body: "# Room" }, { ...save, ifDigest: null }))
      .rejects.toMatchObject({ code: "REALTIME_DOCUMENT_CONFLICT" })
  })

  it("treats BLOB_NOT_FOUND as a missing file and throws other Blob errors", async () => {
    const failing = (code: string): RealtimeBlobStore => ({
      async get() { return [Object.assign(new Error(code), { code }), undefined] },
      async put() { return [null, {}] },
    })
    expect(await blobDocument(failing("BLOB_NOT_FOUND")).load(context)).toEqual({ body: "", digest: null })
    await expect(blobDocument(failing("BLOB_OPERATION_FAILED")).load(context)).rejects.toMatchObject({ code: "BLOB_OPERATION_FAILED" })
  })

  it("re-seeds a room whose Blob file another writer changed, and keeps that file", async () => {
    vi.useFakeTimers()
    const { files, store } = memoryBlob()
    await store.put("page", "Start", { access: "private", contentType: "text/markdown" })
    const server = createTestServer({ document: blobDocument(store), editor: createStubEditor().editor })
    const client = await server.connect("page")
    await settle()
    await vi.advanceTimersByTimeAsync(60)
    await store.put("page", "Someone else", { access: "private", contentType: "text/markdown" })
    appendParagraph(client.doc, "Mine")

    const response = await server.post("page", "save", { state: Y.encodeStateAsUpdate(client.doc) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ data: { code: "REALTIME_SOURCE_CHANGED" } })
    expect(client.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
    expect(files.get("page")?.body).toBe("Someone else")
    client.close()
  })
})

afterEach(() => {
  vi.useRealTimers()
})
