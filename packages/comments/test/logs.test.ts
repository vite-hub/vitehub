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

  it("puts a failed onComment on the request's wide event, without the error or the comment, and keeps the comment", async () => {
    setEvlogBridge({ createLogger: vi.fn() })
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const log = { set: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const { response, body } = await postThread({ onComment: () => { throw Object.assign(new Error("SMTP refused mail to ada@acme.dev"), { code: "EMAIL_REFUSED" }) } }, log)

    expect(response.status).toBe(200)
    expect(log.warn.mock.calls).toEqual([["Comments onComment failed", {
      comments: { hook: "onComment", thread: body.data!.id, code: "EMAIL_REFUSED" },
    }]])
    expect(JSON.stringify([log.set.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toMatch(/ada@acme\.dev|SMTP|The price is wrong/)
    expect(console).not.toHaveBeenCalled()
  })

  it("emits its own event for a failed onMention, which runs after the answer", async () => {
    const events: unknown[] = []
    const kept: unknown[] = []
    setEvlogBridge({ createLogger: (fields, options) => { events.push(fields); if (options?.waitUntil) kept.push(options.waitUntil); return { info() {}, warn() {}, error: error => events.push(error), emit: () => fields } } })
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const comments = await createComments({ onMention: () => { throw new Error("push to grace@acme.dev failed") } })
    await comments.create({ page: "/", anchor, body: "Hello", author: grace })

    const [error, thread] = await comments.create({ page: "/", anchor, body: "Hi @Grace", author: ada, mentions: ["grace"] })
    await comments.flush()

    expect(error).toBeUndefined()
    expect(events).toEqual([{ action: "comments", message: "Comments onMention failed", comments: { hook: "onMention", thread: thread!.id } }])
    expect(kept).toHaveLength(1)
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
