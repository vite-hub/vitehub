import { setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createCommentsHandler } from "../src/runtime/handler.ts"
import { ada, anchor, createComments, grace } from "./harness.ts"

import type { DefineCommentsOptions } from "../src/types.ts"

const origin = "http://site.test"

async function postThread(options: DefineCommentsOptions, log?: object) {
  const comments = await createComments({ identify: () => ada, ...options })
  const handler = createCommentsHandler({ comments, realtime: false })
  const request = new Request(`${origin}/api/_vitehub/comments/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ page: "/pricing", anchor, body: "The price is wrong" }),
  })
  // evlog's Nitro plugin gives each request its logger here.
  if (log) Object.assign(request, { context: { log } })
  const response = await handler.fetch(request)
  await comments.flush()
  return { response, body: await response.json() as { data?: { id: string } } }
}

describe("Comments failures in logs", () => {
  afterEach(() => {
    setEvlogBridge(undefined)
    vi.restoreAllMocks()
  })

  it("puts a failed onComment on the request's wide event, and keeps the comment", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const log = { set: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const { response, body } = await postThread({ onComment: () => { throw Object.assign(new Error("SMTP refused"), { code: "EMAIL_REFUSED" }) } }, log)

    expect(response.status).toBe(200)
    expect(log.warn).toHaveBeenCalledWith("Comments onComment failed: SMTP refused", {
      comments: { hook: "onComment", thread: body.data!.id, code: "EMAIL_REFUSED" },
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("The price is wrong")
    expect(console).not.toHaveBeenCalled()
  })

  it("emits its own event for a failed onMention, which runs after the answer", async () => {
    const events: Array<Record<string, unknown>> = []
    setEvlogBridge({ createLogger: (fields) => { events.push(fields); return { info() {}, warn() {}, error() {}, emit: () => fields } } })
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const comments = await createComments({ onMention: () => { throw new Error("push service down") } })
    // Grace must have written before, so that `@Grace` names a known person.
    await comments.create({ page: "/", anchor, body: "Hello", author: grace })

    const [error, thread] = await comments.create({ page: "/", anchor, body: "Hi @Grace", author: ada, mentions: ["grace"] })
    await comments.flush()

    expect(error).toBeUndefined()
    expect(events).toEqual([{ action: "comments", message: "Comments onMention failed", comments: { hook: "onMention", thread: thread!.id } }])
    expect(console).not.toHaveBeenCalled()
  })

  it("prints a failed onComment to the console without evlog", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const failure = new Error("SMTP refused")

    const { response } = await postThread({ onComment: () => { throw failure } })

    expect(response.status).toBe(200)
    expect(console).toHaveBeenCalledWith("[vitehub] Comments onComment failed:", failure)
  })
})
