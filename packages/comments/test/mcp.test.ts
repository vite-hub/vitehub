import { describe, expect, it } from "vitest"

import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { ada, anchor, createComments } from "./harness.ts"

import type { DefineCommentsOptions } from "../src/types.ts"

async function setup(options: DefineCommentsOptions = {}) {
  const comments = await createComments(options)
  const tools = Object.fromEntries(commentsMcpTools(comments).map(tool => [tool.name, tool]))
  const call = (name: string, input: Record<string, unknown>, user: Record<string, unknown> | null = { id: "ben", name: "Ben", role: "editor" }) => tools[name]!.call(input, { user, event: undefined })
  return { comments, tools, call }
}

describe("Comments MCP tools", () => {
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
    expect(await call("comments_reply", { id: thread!.id, body: "No" }, viewer)).toEqual({ text: "Comments authorize does not allow comment for this user.", isError: true })
    expect((await call("comments_get_thread", { id: "missing" })).isError).toBe(true)
    expect((await call("comments_reply", { id: thread!.id }, undefined)).isError).toBe(true)
  })
})
