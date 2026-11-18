import { openAsBlob } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installStandardContext } from "@vite-hub/runtime/internal/h3"
import { describe, expect, it, vi } from "vitest"

import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { mcpToolResult } from "../src/runtime/index.ts"
import { defineCommentSubject } from "../src/index.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { ada, anchor, createComments } from "./harness.ts"

import type { CommentsIdentifyContext, DefineCommentsOptions } from "../src/types.ts"
import type { H3Event } from "h3"

function event(headers: Record<string, string> = {}): H3Event {
  // SAFETY: Comments identity readers use the request headers from the H3 event.
  const event = { req: new Request("http://site.test/_vitehub/comments/session", { headers }), res: { headers: new Headers() } }
  // The Console sets Standard Context before it passes the event to a tool, as the ViteHub Nitro plugin does.
  installStandardContext(event)
  return event as unknown as H3Event
}

async function setup(options: DefineCommentsOptions = {}) {
  const comments = await createComments(options)
  const tools = Object.fromEntries(commentsMcpTools(comments).map(tool => [tool.name, tool]))
  const call = (name: string, input: Record<string, unknown>, user: Record<string, unknown> | null = { id: "ben", name: "Ben", role: "editor" }) => tools[name]!.call(input, { user })
  return { comments, tools, call }
}

describe("Comments MCP tools", () => {
  it.each([undefined, "matching"])("fills readable pages after denied and nonmatching threads (search: %s)", async (search) => {
    const { comments, call } = await setup({ authorize: ({ thread }) => !thread?.messages[0]?.body.startsWith("Hidden") })
    const [, oldest] = await comments.create({ page: "/pricing", body: "matching oldest", author: ada })
    const [, newer] = await comments.create({ page: "/pricing", body: "matching newer", author: ada })
    for (let index = 0; index < (search ? 500 : 2); index++) {
      await comments.create({ page: "/pricing", body: `Hidden matching ${index}`, author: ada })
    }
    const answer = await call("comments_list_threads", { limit: 2, ...(search ? { search } : {}) })
    expect(answer.structured).toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: newer!.id }), expect.objectContaining({ id: oldest!.id })]) })
    expect(answer.structured?.threads).toHaveLength(2)
    expect(answer.text).not.toContain("Hidden")
  })

  it("filters denied pages and threads from both list answers", async () => {
    const { comments, call } = await setup({ authorize: ({ subject, thread }) => subject?.id !== "/private" && thread?.messages[0]?.body !== "Hidden thread" })
    const [, visible] = await comments.create({ page: "/pricing", body: "Visible", author: ada })
    await comments.create({ page: "/private", body: "Private page", author: ada })
    await comments.create({ page: "/pricing", body: "Hidden thread", author: ada })
    for (const input of [{}, { search: "thread" }, { page: "/pricing" }]) {
      const answer = await call("comments_list_threads", input)
      expect(answer.text).not.toMatch(/Private page|Hidden thread/)
      expect(answer.structured).toEqual({ threads: input.search ? [] : [expect.objectContaining({ id: visible!.id })], hidden: input.page ? 1 : 2 })
    }
    expect((await call("comments_list_threads", { page: "/private" })).isError).toBe(true)
  })

  it("passes the requested page to the list read policy", async () => {
    const { comments, call } = await setup({ authorize: ({ subject }) => subject?.id === "/pricing" })
    const [, thread] = await comments.create({ page: "/pricing", body: "Allowed here", author: ada })
    expect((await call("comments_list_threads", { page: "/pricing/" })).structured).toMatchObject({ threads: [{ id: thread!.id }] })
  })

  it("fills the page limit when newer subjects share the site scope", async () => {
    const { comments, call } = await setup({ subjects: [defineCommentSubject({ kind: "content", scope: () => "site" })] })
    const [, page] = await comments.create({ page: "/pricing", body: "Page feedback", author: ada })
    const [error, content] = await comments.create({ subject: { kind: "content", id: "pages/about" }, body: "Content feedback", author: ada })
    expect(error).toBeUndefined()
    await comments.reply(content!.id, { body: "Newer content activity", author: ada })
    expect((await call("comments_list_threads", { limit: 1 })).structured).toMatchObject({ threads: [{ id: page!.id }] })
  })

  it("trusts the Console user without an authorize policy only when the caller passed the Console check", async () => {
    const comments = await createComments({ authorize: undefined })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Fix this", author: ada })
    const inputs = [{}, { id: thread!.id }, { id: thread!.id, body: "Fixed" }, { id: thread!.id }]
    for (const [index, tool] of commentsMcpTools(comments).entries()) {
      expect((await tool.call(inputs[index]!, { user: ada, event: event() })).isError).toBe(true)
    }
    for (const [index, tool] of commentsMcpTools(comments, { console: true }).entries()) {
      expect((await tool.call(inputs[index]!, { user: ada, event: event() })).isError).toBeUndefined()
      expect((await tool.call(inputs[index]!, { user: null, event: event() })).isError).toBe(true)
    }
    const [, after] = await comments.get(thread!.id)
    expect(after?.messages.at(-1)?.author).toEqual({ id: "ada", name: "Ada" })
    expect(after?.status).toBe("resolved")
  })

  it("shows the Agent the images of a thread, up to the size cap", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const files = new Map([
      ["files/shot.png", new Blob([png], { type: "image/png" })],
      ["files/notes.pdf", new Blob(["%PDF-1.7"], { type: "application/pdf" })],
      ["files/huge.webp", new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "image/webp" })],
    ])
    const { comments, call } = await setup({ readAttachment: key => files.get(key) ?? null })
    const [, thread] = await comments.create({ page: "/", anchor, body: "The button overlaps", author: ada, attachments: ["files/shot.png", "files/notes.pdf"] })
    await comments.reply(thread!.id, { body: "Bigger one", author: ada, attachments: ["files/huge.webp", "files/gone.png"] })

    const read = await call("comments_get_thread", { id: thread!.id })
    const image = { data: btoa(String.fromCharCode(...png)), mimeType: "image/png" }
    expect(read.images).toEqual([image])
    expect(read.text).toContain("Not shown: files/huge.webp, because the images of one answer stay under 4 MB.")
    expect(read.text).toContain("Could not read files/gone.png: ")
    expect(mcpToolResult(read)).toEqual({ content: [{ type: "text", text: read.text }, { type: "image", ...image }], structuredContent: read.structured, isError: false })
  })

  it("keeps other images and their byte budget when a file-backed image cannot be read", async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), "comments-mcp-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const path = join(directory, "gone.webp")
    await writeFile(path, new Uint8Array(4 * 1024 * 1024))
    const gone = await openAsBlob(path, { type: "image/webp" })
    await rm(path)
    const { comments, call } = await setup({ readAttachment: key => key === "files/gone.webp" ? gone : new Blob(["image"], { type: "image/png" }) })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Two images", author: ada, attachments: ["files/gone.webp", "files/shot.png"] })

    const read = await call("comments_get_thread", { id: thread!.id })
    expect(read.text).toContain("Two images")
    expect(read.text).toContain("Could not read files/gone.webp: The file could not be loaded.")
    expect(read.images).toEqual([{ data: btoa("image"), mimeType: "image/png" }])
  })

  it("logs attachment hook failures without sending storage details to the Agent", async ({ onTestFinished }) => {
    const directory = await mkdtemp(join(tmpdir(), "comments-mcp-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const path = join(directory, "missing.png")
    const { comments, call } = await setup({ readAttachment: async () => new Blob([await readFile(path)], { type: "image/png" }) })
    const [, thread] = await comments.create({ page: "/", body: "Still readable", author: ada, attachments: ["files/missing.png"] })

    const read = await call("comments_get_thread", { id: thread!.id })
    expect(read.text).not.toContain(path)
    expect(read.text).toContain("Could not read files/missing.png: The file could not be loaded.")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("files/missing.png"), expect.objectContaining({ code: "ENOENT", path }))
  })

  it("lets custom identify and authorize decide for Console callers with a request", async () => {
    const identify = vi.fn(() => ada)
    const authorize = vi.fn(() => true)
    const comments = await createComments({ identify, authorize })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Private", author: ada })
    const inputs = [{}, { id: thread!.id }, { id: thread!.id, body: "Fixed" }, { id: thread!.id }]
    for (const [index, tool] of commentsMcpTools(comments, { console: true }).entries()) {
      expect((await tool.call(inputs[index]!, { user: { id: "other" }, event: event() })).isError).toBeUndefined()
    }
    expect(identify).toHaveBeenCalled()
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ user: ada }))
    const [, after] = await comments.get(thread!.id)
    expect(after?.messages).toHaveLength(2)
    expect(after?.status).toBe("resolved")
  })

  it("keeps anonymous callers anonymous for every action", async () => {
    const { comments, call } = await setup({ authorize: ({ user }) => user !== null })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Private", author: ada })
    for (const [name, input] of [
      ["comments_list_threads", {}],
      ["comments_get_thread", { id: thread!.id }],
      ["comments_reply", { id: thread!.id, body: "No" }],
      ["comments_resolve_thread", { id: thread!.id }],
    ] as const) {
      expect((await call(name, input, null)).isError).toBe(true)
    }
    const [, after] = await comments.get(thread!.id)
    expect(after?.messages).toHaveLength(1)
    expect(after?.status).toBe("open")
  })

  it("uses the configured Comments identity ahead of the Console user", async () => {
    const seen: unknown[] = []
    const comments = await createComments({
      identify: ({ event }) => event["~standard"].req.headers.get("x-person") === "ada" ? ada : null,
      authorize: ({ user }) => { seen.push(user); return Boolean(user) },
    })
    const tool = commentsMcpTools(comments)[0]!
    const api = createCommentsHandler({ comments, realtime: false })
    const request = event({ "x-person": "ada" })
    await api.fetch(request.req)
    expect((await tool.call({}, { user: { id: "other" }, event: request })).isError).toBeUndefined()
    // The HTTP session checks read, comment, resolve, and delete; the tool checks read again.
    expect(seen).toEqual([ada, ada, ada, ada, ada])
    expect((await tool.call({}, { user: ada, event: event() })).isError).toBe(true)
  })

  it("uses the checked custom-server user without a request event", async () => {
    const seen: unknown[] = []
    const identify = vi.fn(({ event }: CommentsIdentifyContext) => event["~standard"].req.headers.get("x-person") === "ada" ? ada : null)
    const comments = await createComments({
      identify,
      authorize: ({ user }) => { seen.push(user); return user?.role === "editor" },
    })
    const tools = commentsMcpTools(comments, { console: true })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Fix this", author: ada })
    const user = { id: "ben", name: "Ben", role: "editor" }
    const inputs = [{}, { id: thread!.id }, { id: thread!.id, body: "Fixed" }, { id: thread!.id }]
    for (const [index, tool] of tools.entries()) {
      expect((await tool.call(inputs[index]!, { user })).isError).toBeUndefined()
    }
    const [, after] = await comments.get(thread!.id)
    expect(after?.messages.at(-1)?.author).toEqual({ id: "ben", name: "Ben" })
    expect(after?.resolvedBy).toEqual({ id: "ben", name: "Ben" })
    expect((await tools[3]!.call({ id: thread!.id, resolved: false }, { user })).isError).toBeUndefined()
    expect(seen).toEqual(Array(6).fill(user))
    for (const [index, tool] of tools.entries()) {
      expect((await tool.call(inputs[index]!, { user: null })).isError).toBe(true)
    }
    expect(identify).not.toHaveBeenCalled()
  })

  it("keeps the Console user as author, and names permitted anonymous guests", async () => {
    const seen: unknown[] = []
    const comments = await createComments({ authorize: ({ user }) => { seen.push(user); return user === null || user?.email === "ada@site.test" } })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi", author: ada })
    const person = { id: "ada@site.test", name: "Ada", email: "ada@site.test" }
    const tools = commentsMcpTools(comments, { console: true })
    expect((await tools[2]!.call({ id: thread!.id, body: "Fixed" }, { user: person, event: event() })).isError).toBeUndefined()
    expect((await tools[3]!.call({ id: thread!.id }, { user: person, event: event() })).isError).toBeUndefined()
    const [, after] = await comments.get(thread!.id)
    expect(after?.messages.at(-1)?.author).toEqual({ id: person.id, name: person.name })
    expect(after?.resolvedBy).toEqual({ id: person.id, name: person.name })

    await comments.reopen(thread!.id)
    const headers = { "x-vitehub-comments-guest-id": "ben", "x-vitehub-comments-guest-name": "Ben" }
    const request = event(headers)
    expect((await tools[2]!.call({ id: thread!.id, body: "Thanks" }, { user: null, event: request })).isError).toBeUndefined()
    expect((await tools[3]!.call({ id: thread!.id }, { user: null, event: request })).isError).toBeUndefined()
    const [, updated] = await comments.get(thread!.id)
    expect(updated?.messages.at(-1)?.author).toEqual({ id: "guest:ben", name: "Ben", guest: true })
    expect(updated?.resolvedBy).toEqual({ id: "guest:ben", name: "Ben", guest: true })
    expect(seen).toEqual([person, person, null, null])

    const privateComments = await createComments({ authorize: undefined })
    const [, privateThread] = await privateComments.create({ page: "/", anchor, body: "Private", author: ada })
    for (const tool of commentsMcpTools(privateComments, { console: true })) {
      expect((await tool.call({ id: privateThread!.id, body: "Denied" }, { user: null, event: request })).isError).toBe(true)
    }
    const [, unchanged] = await privateComments.get(privateThread!.id)
    expect(unchanged?.messages).toHaveLength(1)
    expect(unchanged?.status).toBe("open")
  })

  it("lists, reads, replies to, and resolves threads as the Console user", async () => {
    const { comments, tools, call } = await setup()
    expect(Object.keys(tools)).toEqual(["comments_list_threads", "comments_get_thread", "comments_reply", "comments_resolve_thread"])
    expect(Object.values(tools).every(tool => tool.section === "comments")).toBe(true)
    const [, thread] = await comments.create({
      page: "/pricing",
      anchor,
      context: { url: "https://site.test/pricing", components: [{ name: "PricingCard", files: ["app/components/PricingCard.vue"] }] },
      body: "The price is cut off",
      author: ada,
    })

    const list = await call("comments_list_threads", {})
    expect(list.text).toBe(`- #${thread!.n} ${thread!.id} /pricing on "h1 Pricing", updated ${new Date(thread!.updatedAt).toISOString().slice(0, 16)}Z: The price is cut off (Ada, 0 replies, in PricingCard)`)
    expect(list.structured).toMatchObject({ threads: [{ id: thread!.id, components: ["PricingCard"] }] })
    expect((await call("comments_list_threads", { search: "nothing" })).text).toBe("No open threads.")

    const read = await call("comments_get_thread", { id: thread!.id })
    expect(read.text).toContain("Files: app/components/PricingCard.vue")
    expect(read.text).toContain("Ada, ")

    // An agent learns which part of the element an area marks, and which files a message carries.
    const [, area] = await comments.create({ page: "/pricing", anchor: { kind: "area", selector: "iframe", x: 5, y: 4, width: 973, height: 977 }, body: "Too busy", attachments: ["comments/shot.png"], author: ada })
    const areaText = (await call("comments_get_thread", { id: area!.id })).text
    expect(areaText).toContain("Anchor: an area of iframe, 97.3% wide and 97.7% high, from 0.5% left and 0.4% top of its box")
    expect(areaText).toContain("Attachments: comments/shot.png")

    const replied = await call("comments_reply", { id: thread!.id, body: "Fixed the width" })
    expect(replied.isError).toBeUndefined()
    const resolved = await call("comments_resolve_thread", { id: thread!.id })
    expect(resolved.text).toBe(`Thread ${thread!.id} is resolved.`)
    const [, after] = await comments.get(thread!.id)
    expect(after?.messages.at(-1)?.author).toEqual({ id: "ben", name: "Ben" })
    expect(after?.resolvedBy).toEqual({ id: "ben", name: "Ben" })
    expect((await call("comments_resolve_thread", { id: thread!.id, resolved: false })).text).toBe(`Thread ${thread!.id} is open.`)
  })

  it("filters by a full URL of the page as well as a path", async () => {
    const { comments, call } = await setup({ authorize: () => true })
    const [, pricing] = await comments.create({ page: "/pricing", body: "On pricing", author: ada })
    await comments.create({ page: "/", body: "On home", author: ada })
    for (const page of ["https://drop.vitehub.dev/pricing", "https://drop.vitehub.dev/pricing/?plan=pro#top", "/pricing"]) {
      expect((await call("comments_list_threads", { page })).structured).toEqual({ threads: [expect.objectContaining({ id: pricing!.id, page: "/pricing" })], hidden: 0 })
    }
  })

  it("says how many threads authorize hid instead of \"No open threads.\"", async () => {
    const { comments, call } = await setup({ authorize: ({ thread }) => !thread || thread.messages[0]?.body === "Visible" })
    for (let index = 0; index < 2; index++) await comments.create({ page: "/pricing", body: "Hidden", author: ada })
    const empty = await call("comments_list_threads", {})
    expect(empty).toEqual({ text: "No open threads that this caller may read. `authorize` hid 2 threads from this caller.", structured: { threads: [], hidden: 2 } })
    const [, visible] = await comments.create({ page: "/pricing", body: "Visible", author: ada })
    const listed = await call("comments_list_threads", {})
    expect(listed.structured).toEqual({ threads: [expect.objectContaining({ id: visible!.id })], hidden: 2 })
    expect(listed.text).toMatch(/\n\n`authorize` hid 2 threads from this caller\.$/)
  })

  it("names the identify cause when a Console caller has no app user", async () => {
    const comments = await createComments({ identify: () => null, authorize: ({ user, thread }) => !thread || user !== null })
    await comments.create({ page: "/pricing", body: "Hidden", author: ada })
    const [tool] = commentsMcpTools(comments, { console: true })
    expect((await tool!.call({}, { user: null, event: event() })).text).toBe("No open threads that this caller may read. `authorize` hid 1 thread from this caller. With `identify`, a Console call has no app user: allow Console callers in `authorize` with `({ console }) => console`.")
    const [own] = commentsMcpTools(comments)
    expect((await own!.call({}, { user: null, event: event() })).text).toBe("No open threads that this caller may read. `authorize` hid 1 thread from this caller, because `identify` found no user for this call.")
  })

  it.each([true, false])("gives authorize the Console flag of the tools (identify: %s)", async (withIdentify) => {
    const seen: unknown[] = []
    const comments = await createComments({
      ...(withIdentify ? { identify: () => ada } : {}),
      authorize: ({ console }) => { seen.push(console); return console === true },
    })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Fix this", author: ada })
    const inputs = [{}, { id: thread!.id }, { id: thread!.id, body: "Fixed" }, { id: thread!.id }]
    for (const [index, tool] of commentsMcpTools(comments, { console: true }).entries()) {
      expect((await tool.call(inputs[index]!, { user: ada, event: event() })).isError).toBeUndefined()
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(flag => flag === true)).toBe(true)
    seen.length = 0
    for (const [index, tool] of commentsMcpTools(comments).entries()) {
      expect((await tool.call(inputs[index]!, { user: ada, event: event() })).isError).toBe(true)
    }
    expect(seen.every(flag => flag === false)).toBe(true)
  })

  it("checks authorize for each call, and reports missing threads", async () => {
    const { comments, call } = await setup({ authorize: ({ user, action }) => action === "read" || user?.role === "editor" })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi", author: ada })
    const viewer = { id: "cy", name: "Cy" }
    expect((await call("comments_get_thread", { id: thread!.id }, viewer)).isError).toBeUndefined()
    expect(await call("comments_reply", { id: thread!.id, body: "No" }, viewer)).toEqual({ text: expect.stringContaining("denied `write` for this user"), isError: true })
    expect((await call("comments_get_thread", { id: "missing" })).isError).toBe(true)
    expect((await call("comments_reply", { id: thread!.id }, undefined)).isError).toBe(true)
  })
})
