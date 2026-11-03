// @vitest-environment node
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineComments, defineCommentSubject, installComments } from "../src/index.ts"
import { commentsOperations } from "../src/operations-core/operations.ts"
import { installCommentsRuntime } from "../src/operations-core/server.ts"
import { ada, createDatabase, grace } from "./harness.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { DefineCommentsOptions } from "../src/types.ts"
import type { InstallCommentsOptions } from "../src/index.ts"

const registry = createOperationRegistry([{ operations: commentsOperations }])
const page = { kind: "page", id: "/pricing" }
const png = btoa(String.fromCharCode(0x89, 0x50, 0x4E, 0x47))

afterEach(() => {
  installCommentsRuntime(() => { throw new Error("not installed") })
})

async function setup(options: DefineCommentsOptions = {}, install: Partial<InstallCommentsOptions> = {}) {
  const comments = defineComments({ authorize: () => true, ...options })
  installComments(comments, { database: await createDatabase(), ...install })
  return comments
}

function call(name: string, input: unknown, context: Partial<OperationContext> = {}) {
  return runOperation(registry, name, input, { access: { mode: "auth", sections: "all" }, surface: "console", user: ada, ...context })
}

describe("attachments", () => {
  it("stores an upload with storeAttachment, and a message keeps its key without text", async () => {
    const storeAttachment = vi.fn(async (file: { name: string, type: string, size: number, data: Uint8Array }) => `drops/${file.name}`)
    await setup({ storeAttachment })
    const uploaded = await call("comments.upload", { name: "shot 1.png", type: "image/png", data: png, subject: page })
    expect(uploaded).toEqual({ ok: true, value: { key: "drops/shot-1.png", name: "shot-1.png", size: 4, type: "image/png" } })
    expect(storeAttachment).toHaveBeenCalledWith(expect.objectContaining({ data: new Uint8Array([0x89, 0x50, 0x4E, 0x47]) }), { user: ada, subject: page })
    const created = await call("comments.create", { subject: page, anchor: { kind: "page" }, body: "", attachments: ["drops/shot-1.png"] })
    expect(created).toMatchObject({ ok: true, value: { messages: [{ body: "", attachments: ["drops/shot-1.png"] }] } })
  })

  it("stores an upload in the Blob store by default", async () => {
    const put = vi.fn(async () => [undefined, {}] as const)
    await setup({}, { attachments: { put } })
    const uploaded = await call("comments.upload", { name: "notes.txt", type: "text/plain; charset=utf-8", data: btoa("hello") })
    expect(uploaded).toMatchObject({ ok: true, value: { key: expect.stringMatching(/^comments\/[\w-]+\/notes\.txt$/), type: "text/plain", size: 5 } })
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^comments\//), new TextEncoder().encode("hello"), { contentType: "text/plain" })
  })

  it("refuses files it cannot store, of other types, or over 5 MB", async () => {
    await setup()
    expect(await call("comments.upload", { name: "a.png", type: "image/png", data: png })).toMatchObject({ ok: false, code: "COMMENTS_R0014", status: 501 })
    await setup({ storeAttachment: () => "key" })
    expect(await call("comments.upload", { name: "a.svg", type: "image/svg+xml", data: png })).toMatchObject({ ok: false, code: "COMMENTS_R0017", status: 415 })
    expect(await call("comments.upload", { name: "a.png", type: "image/png", data: "not base64!" })).toMatchObject({ ok: false, code: "COMMENTS_R0017" })
    const large = btoa("x".repeat(5 * 1024 * 1024 + 3))
    expect(await call("comments.upload", { name: "a.png", type: "image/png", data: large })).toMatchObject({ ok: false, status: 413 })
  })

  it("needs text without attachments", async () => {
    await setup()
    expect(await call("comments.create", { subject: page, anchor: { kind: "page" }, body: " " })).toMatchObject({ ok: false, code: "COMMENTS_R0005" })
  })
})

describe("people and mentions", () => {
  it("lets an explicit people option win, filtered by canMention", async () => {
    const team = [{ id: "ada", name: "Ada" }, { id: "grace", name: "Grace" }, { id: "lin", name: "Lin" }]
    const canMention = vi.fn(({ person }: { person: { id: string } }) => person.id !== "lin")
    await setup({ people: { search: query => team.filter(person => person.name.toLowerCase().includes(query)), byIds: ids => team.filter(person => ids.includes(person.id)) }, canMention })
    expect(await call("comments.users", { query: "a", limit: 10, subject: page })).toEqual({ ok: true, value: [] })
    expect(await call("comments.users", { query: "ra", subject: page })).toEqual({ ok: true, value: [{ id: "grace", name: "Grace" }] })
    expect(await call("comments.users", { query: "li", subject: page })).toEqual({ ok: true, value: [] })
    expect(canMention).toHaveBeenCalledWith(expect.objectContaining({ subject: page, user: ada }))
    expect(await call("comments.create", { subject: page, anchor: { kind: "page" }, body: "Hi @Lin", mentions: ["lin"] })).toMatchObject({ ok: false, code: "COMMENTS_R0007" })
    expect(await call("comments.create", { subject: page, anchor: { kind: "page" }, body: "Hi @Grace", mentions: ["grace"] })).toMatchObject({ ok: true })
  })

  it("calls onMention once per message with the people and a link, and only for new mentions on edit", async () => {
    const onMention = vi.fn()
    const pending: Promise<unknown>[] = []
    const comments = await setup({ onMention, subjects: [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}`, link: thread => `/docs/${thread.subject.id}?comment=${thread.n}` })] })
    await comments.create({ subject: page, body: "Earlier", author: grace })
    const created = await call("comments.create", { subject: { kind: "doc", id: "7" }, anchor: { kind: "page" }, body: "@Grace look", mentions: ["grace"] }, { waitUntil: task => { pending.push(task) } })
    await Promise.all(pending)
    expect(onMention).toHaveBeenCalledOnce()
    expect(onMention.mock.calls[0]![0]).toMatchObject({ users: [grace], link: "/docs/7?comment=1" })
    if (!created.ok) throw new Error(created.message)
    const thread = created.value as { id: string, messages: Array<{ id: string }> }
    await call("comments.edit", { threadId: thread.id, messageId: thread.messages[0]!.id, body: "@Grace look again", mentions: ["grace"] }, { waitUntil: task => { pending.push(task) } })
    await Promise.all(pending)
    expect(onMention).toHaveBeenCalledOnce()
    await comments.flush()
  })
})

describe("guests through the operations", () => {
  it("lets a guest of the request write when the policy allows anonymous people, and never own a message", async () => {
    await setup({ authorize: ({ action }) => action !== "delete" })
    const request = new Request("https://example.com/", { headers: { "x-vitehub-comments-guest-id": "g1", "x-vitehub-comments-guest-name": "Lin" } })
    const created = await call("comments.create", { subject: page, anchor: { kind: "page" }, body: "Hi" }, { user: null, request })
    expect(created).toMatchObject({ ok: true, value: { author: { id: "guest:g1", name: "Lin", guest: true } } })
    if (!created.ok) throw new Error(created.message)
    expect(await call("comments.delete", { threadId: (created.value as { id: string }).id }, { user: null, request })).toMatchObject({ ok: false, status: 403 })
    expect(await call("comments.create", { subject: page, anchor: { kind: "page" }, body: "Hi" }, { user: null })).toMatchObject({ ok: false, code: "COMMENTS_R0012" })
  })

  it("lets anonymous people in only on the development server without a policy", async () => {
    const comments = defineComments()
    installComments(comments, { database: await createDatabase() })
    await comments.create({ subject: page, body: "Hi", author: ada })
    expect(await call("comments.list", {}, { user: null })).toEqual({ ok: true, value: [] })
    expect(await call("comments.list", {}, { user: null, development: true })).toMatchObject({ ok: true, value: [{ subject: page }] })
    expect(await call("comments.list", {}, { user: grace })).toMatchObject({ ok: true, value: [{ subject: page }] })
  })
})
