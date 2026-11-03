import { H3 } from "h3"
import { describe, expect, it } from "vitest"

import { createCommentsClient, createRestTransport } from "../src/client.ts"
import { defineCommentSubject } from "../src/index.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { anchor, createComments } from "./harness.ts"

import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"

const origin = "http://site.test"

/** A transport against the real Comments API, as a browser on the same origin sends it. */
async function setup(options: DefineCommentsOptions = {}, attachments?: Map<string, Blob>) {
  const comments = await createComments({
    subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
    // A share link names its reader in a header, as Drop's links do.
    identify: ({ event }) => {
      const token = event.req.headers.get("x-share-token")
      return token === "ada" ? { id: "ada", name: "Ada" } : token === "ben" ? { id: "ben", name: "Ben" } : null
    },
    ...(attachments
      ? {
          storeAttachment: (file) => {
            const key = `files/${attachments.size + 1}/${file.name}`
            attachments.set(key, new Blob([file.data.slice()], { type: file.type }))
            return key
          },
          readAttachment: key => attachments.get(key) ?? null,
        }
      : {}),
    ...options,
  })
  const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), origin), init)
    // Browsers send Origin on writes.
    if (request.method !== "GET") request.headers.set("origin", origin)
    return await app.fetch(request)
  }) as typeof globalThis.fetch
  const as = (token: string | undefined, guest?: { id: string, name: string }) => createRestTransport({
    fetch,
    headers: (): HeadersInit => (token ? { "x-share-token": token } : {}),
    ...(guest ? { guest } : {}),
  })
  return { comments, as, app }
}

describe("createRestTransport", () => {
  it("runs every transport method against the Comments API, on an app subject", async () => {
    const { as } = await setup()
    const ada = as("ada")
    const ben = as("ben")
    const subject = { kind: "drop", id: "42" }
    const created = await ada.create({ subject, anchor: { kind: "page" }, body: "Hello @Ben", mentions: [] })
    expect(created).toMatchObject({ subject, scope: "drop:42", n: 1, author: { id: "ada", name: "Ada" }, messages: [{ body: "Hello @Ben" }] })

    const replied = await ben.reply({ threadId: created.id, body: "Hi @Ada", mentions: ["ada"] })
    expect(replied.messages).toHaveLength(2)
    expect(replied.messages[1]).toMatchObject({ author: { id: "ben" }, mentions: ["ada"] })

    const edited = await ben.edit({ threadId: created.id, messageId: replied.messages[1]!.id, body: "Hi again" })
    expect(edited.messages[1]).toMatchObject({ body: "Hi again", mentions: [] })
    await expect(ada.edit({ threadId: created.id, messageId: replied.messages[1]!.id, body: "Not mine" })).rejects.toMatchObject({ code: "COMMENTS_FORBIDDEN", status: 403 })

    expect((await ada.list({ subject })).map(thread => thread.id)).toEqual([created.id])
    expect(await ada.list({ subject: { kind: "drop", id: "7" } })).toEqual([])
    expect(await ada.get({ id: created.id })).toMatchObject({ id: created.id })
    expect(await ada.get({ scope: "drop:42", n: 1 })).toMatchObject({ id: created.id })
    expect(await ada.get({ id: "thread_missing" })).toBeNull()

    expect(await ada.users({ query: "Be", threadId: created.id })).toEqual([{ id: "ben", name: "Ben" }])
    expect(await ada.resolve({ threadId: created.id })).toMatchObject({ status: "resolved", resolvedBy: { id: "ada" } })
    expect(await ada.reopen({ threadId: created.id })).toMatchObject({ status: "open" })

    const afterDelete = await ben.delete({ threadId: created.id, messageId: replied.messages[1]!.id })
    expect(afterDelete?.messages).toHaveLength(1)
    expect(await ada.delete({ threadId: created.id })).toBeNull()
    expect(await ada.list({ subject })).toEqual([])
  })

  it("paginates beyond the first 200 page threads", async () => {
    const { comments, as } = await setup()
    const subject = { kind: "page", id: "/many" }
    for (let index = 0; index < 205; index++) await comments.create({ subject, body: `Thread ${index}`, author: { id: "ada" } })
    const transport = as("ada")
    const first = await transport.list({ subject, limit: 200 })
    expect(first).toHaveLength(200)
    const last = first.at(-1)!
    const second = await transport.list({ subject, limit: 200, before: { id: last.id, updatedAt: last.updatedAt } })
    expect(second).toHaveLength(5)
    expect(new Set([...first, ...second].map(thread => thread.id)).size).toBe(205)
  })

  it("honours authorize for the user of each request", async () => {
    const { as } = await setup({ authorize: ({ user, action }) => action === "read" || user?.id === "ada" })
    const created = await as("ada").create({ subject: { kind: "drop", id: "1" }, anchor: { kind: "page" }, body: "Mine" })
    await expect(as("ben").reply({ threadId: created.id, body: "No" })).rejects.toMatchObject({ code: "COMMENTS_FORBIDDEN", status: 403 })
    await expect(as("ben").resolve({ threadId: created.id })).rejects.toMatchObject({ code: "COMMENTS_FORBIDDEN" })
    expect(await as("ben").list({ subject: { kind: "drop", id: "1" } })).toHaveLength(1)
  })

  it("lets a guest write with the guest headers when the policy lets anonymous people in, and never as a person", async () => {
    const { as } = await setup({ authorize: ({ action }) => action !== "delete" })
    const guest = as(undefined, { id: "7", name: "Visitor" })
    const created = await guest.create({ subject: { kind: "page", id: "/pricing" }, anchor, body: "From a share link" })
    expect(created.author).toEqual({ id: "guest:7", name: "Visitor", guest: true })
    await expect(guest.delete({ threadId: created.id })).rejects.toMatchObject({ code: "COMMENTS_FORBIDDEN" })
    // A guest without a name cannot write.
    await expect(as(undefined).reply({ threadId: created.id, body: "Who?" })).rejects.toMatchObject({ code: "COMMENTS_FORBIDDEN" })
  })

  it("keeps a client fresh through the transport", async () => {
    const { as } = await setup()
    const transport = as("ada")
    const user: CommentsUser = { id: "ada", name: "Ada" }
    const client = createCommentsClient({ transport, user, query: { subject: { kind: "drop", id: "9" } } })
    await client.create({ subject: { kind: "drop", id: "9" }, anchor: { kind: "page" }, body: "Through the client" })
    await client.refresh()
    expect(client.threads.map(thread => thread.messages[0]?.body)).toEqual(["Through the client"])
  })

  it("uploads a file, and serves it to readers of its thread with safe headers", async () => {
    const files = new Map<string, Blob>()
    const { as, app } = await setup({ authorize: ({ user, thread }) => !thread || thread.author.id === user?.id }, files)
    const ada = as("ada")
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
    const stored = await ada.upload({ name: "shot.png", type: "image/png", data: Buffer.from(png).toString("base64"), subject: { kind: "drop", id: "1" } })
    expect(stored).toEqual({ key: "files/1/shot.png", name: "shot.png", type: "image/png", size: 7 })
    const url = ada.attachmentUrl(stored.key)
    expect(url).toBe("/api/_vitehub/comments/attachments/files/1/shot.png")

    const read = (token: string, path = url) => app.fetch(new Request(`${origin}${path}`, { headers: { "x-share-token": token } }))
    // Nobody reads a file before a message lists it.
    expect((await read("ada")).status).toBe(404)
    await ada.create({ subject: { kind: "drop", id: "1" }, anchor: { kind: "page" }, body: "", attachments: [stored.key] })

    const response = await read("ada")
    expect(response.status).toBe(200)
    expect(Object.fromEntries(["content-type", "content-disposition", "x-content-type-options", "content-security-policy"].map(name => [name, response.headers.get(name)]))).toEqual({
      "content-type": "image/png",
      "content-disposition": "inline; filename*=UTF-8''shot.png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
    // Ben may not read Ada's thread, so the file is not found for him.
    const denied = await read("ben")
    expect(denied.status).toBe(404)
    expect(await denied.json()).toMatchObject({ error: { code: "COMMENTS_R0020" } })
  })

  it("serves a stored type that Comments does not attach, such as SVG from the app's hook, as a download", async () => {
    const files = new Map<string, Blob>([["files/evil.svg", new Blob(["<svg onload=alert(1)>"], { type: "image/svg+xml" })]])
    const { as, app } = await setup({}, files)
    await as("ada").create({ subject: { kind: "drop", id: "1" }, anchor: { kind: "page" }, body: "See", attachments: ["files/evil.svg"] })
    const response = await app.fetch(new Request(`${origin}/api/_vitehub/comments/attachments/files/evil.svg`, { headers: { "x-share-token": "ada" } }))
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''evil.svg")
  })
})
