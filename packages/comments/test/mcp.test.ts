import { describe, expect, it, vi } from "vitest"

import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { commentsConsoleSession } from "../src/runtime/console-session.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { ada, anchor, createComments } from "./harness.ts"

import type { DefineCommentsOptions } from "../src/types.ts"
import type { H3Event } from "h3"

function event(headers: Record<string, string> = {}): H3Event {
  // SAFETY: Comments identity readers use the request headers from the H3 event.
  return { req: new Request("http://site.test/api/_vitehub/comments/session", { headers }) } as H3Event
}

async function setup(options: DefineCommentsOptions = {}) {
  const comments = await createComments(options)
  const tools = Object.fromEntries(commentsMcpTools(comments).map(tool => [tool.name, tool]))
  const call = (name: string, input: Record<string, unknown>, user: Record<string, unknown> | null = { id: "ben", name: "Ben", role: "editor" }) => tools[name]!.call(input, { user })
  return { comments, tools, call }
}

describe("Comments MCP tools", () => {
  it("keeps anonymous callers anonymous for every action", async () => {
    const { comments, call } = await setup()
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
    expect(after?.comments).toHaveLength(1)
    expect(after?.status).toBe("open")
  })

  it("uses the configured Comments identity ahead of the Console user", async () => {
    const seen: unknown[] = []
    const comments = await createComments({
      identify: ({ event }) => event.req.headers.get("x-person") === "ada" ? ada : null,
      authorize: ({ user }) => { seen.push(user); return Boolean(user) },
    })
    const tool = commentsMcpTools(comments)[0]!
    const api = createCommentsHandler({ comments, realtime: false })
    const request = event({ "x-person": "ada" })
    await api(request)
    expect((await tool.call({}, { user: { id: "other" }, event: request })).isError).toBeUndefined()
    expect(seen).toEqual([ada, ada, ada, ada])
    expect((await tool.call({}, { user: ada, event: event() })).isError).toBe(true)
  })

  it("uses the checked custom-server user without a request event", async () => {
    const seen: unknown[] = []
    const identify = vi.fn(({ event }: { event: H3Event }) => event.req.headers.get("x-person") === "ada" ? ada : null)
    const session = vi.fn(async () => ada)
    const comments = await createComments({
      identify,
      authorize: ({ user }) => { seen.push(user); return user?.role === "editor" },
    })
    const tools = commentsMcpTools(comments, { session })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Fix this", author: ada })
    const user = { id: "ben", name: "Ben", role: "editor" }
    const inputs = [{}, { id: thread!.id }, { id: thread!.id, body: "Fixed" }, { id: thread!.id }]
    for (const [index, tool] of tools.entries()) {
      expect((await tool.call(inputs[index]!, { user })).isError).toBeUndefined()
    }
    const [, after] = await comments.get(thread!.id)
    expect(after?.comments.at(-1)?.author).toEqual({ id: "ben", name: "Ben" })
    expect(after?.resolvedBy).toEqual({ id: "ben", name: "Ben" })
    expect((await tools[3]!.call({ id: thread!.id, resolved: false }, { user })).isError).toBeUndefined()
    expect(seen).toEqual(Array(5).fill(user))
    for (const [index, tool] of tools.entries()) {
      expect((await tool.call(inputs[index]!, { user: null })).isError).toBe(true)
    }
    expect(identify).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
  })

  it("preserves the Console session's Cloudflare person and chosen guest", async () => {
    const comments = await createComments({ authorize: ({ user }) => user?.email === "ada@site.test" || user?.guest === true })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi", author: ada })
    const person = { id: "ada@site.test", name: "Ada", email: "ada@site.test" }
    const session = commentsConsoleSession({ authorize: async () => true, user: async () => null, identify: async () => person })
    const tools = commentsMcpTools(comments, { session })
    expect((await tools[2]!.call({ id: thread!.id, body: "Fixed" }, { user: null, event: event() })).isError).toBeUndefined()
    expect((await tools[3]!.call({ id: thread!.id }, { user: null, event: event() })).isError).toBeUndefined()
    const [, after] = await comments.get(thread!.id)
    expect(after?.comments.at(-1)?.author).toEqual({ id: person.id, name: person.name })
    expect(after?.resolvedBy).toEqual({ id: person.id, name: person.name })

    const guestSession = commentsConsoleSession({ authorize: async () => true, user: async () => null, identify: async () => ({ id: "guest-123" }) })
    const guestTools = commentsMcpTools(comments, { session: guestSession })
    await comments.reopen(thread!.id)
    expect((await guestTools[2]!.call({ id: thread!.id, body: "Thanks" }, { user: null, event: event({ "x-vitehub-comments-guest-id": "ben", "x-vitehub-comments-guest-name": "Ben" }) })).isError).toBeUndefined()
    const [, updated] = await comments.get(thread!.id)
    expect(updated?.comments.at(-1)?.author).toEqual({ id: "guest:ben", name: "Ben", guest: true })
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
    expect(list.text).toBe(`- ${thread!.id} /pricing: The price is cut off (Ada, 0 replies, in PricingCard)`)
    expect(list.structured).toMatchObject({ threads: [{ id: thread!.id, components: ["PricingCard"] }] })
    expect((await call("comments_list_threads", { search: "nothing" })).text).toBe("No open threads.")

    const read = await call("comments_get_thread", { id: thread!.id })
    expect(read.text).toContain("Files: app/components/PricingCard.vue")
    expect(read.text).toContain("Ada, ")

    const replied = await call("comments_reply", { id: thread!.id, body: "Fixed the width" })
    expect(replied.isError).toBeUndefined()
    const resolved = await call("comments_resolve_thread", { id: thread!.id })
    expect(resolved.text).toBe(`Thread ${thread!.id} is resolved.`)
    const [, after] = await comments.get(thread!.id)
    expect(after?.comments.at(-1)?.author).toEqual({ id: "ben", name: "Ben" })
    expect(after?.resolvedBy).toEqual({ id: "ben", name: "Ben" })
    expect((await call("comments_resolve_thread", { id: thread!.id, resolved: false })).text).toBe(`Thread ${thread!.id} is open.`)
  })

  it("checks authorize for each call, and reports missing threads", async () => {
    const { comments, call } = await setup({ authorize: ({ user, action }) => action === "read" || user?.role === "editor" })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi", author: ada })
    const viewer = { id: "cy", name: "Cy" }
    expect((await call("comments_get_thread", { id: thread!.id }, viewer)).isError).toBeUndefined()
    expect(await call("comments_reply", { id: thread!.id, body: "No" }, viewer)).toEqual({ text: expect.stringContaining("denied `comment` for this user"), isError: true })
    expect((await call("comments_get_thread", { id: "missing" })).isError).toBe(true)
    expect((await call("comments_reply", { id: thread!.id }, undefined)).isError).toBe(true)
  })
})
