import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { normalizeRequestBody } from "../server/utils/normalize-request-body"

describe("normalizeRequestBody", () => {
  it("adds a text reader to node-style requests", async () => {
    const request = Readable.from([JSON.stringify({ ok: true })]) as Readable & {
      body?: unknown
      text?: () => Promise<string>
    }

    normalizeRequestBody(request)

    expect(await request.text?.()).toBe("{\"ok\":true}")
  })

  it("reuses pre-parsed bodies", async () => {
    const request = {
      body: { provider: "vercel" },
    } as {
      body: unknown
      text?: () => Promise<string>
    }

    normalizeRequestBody(request)

    expect(await request.text?.()).toBe("{\"provider\":\"vercel\"}")
  })
})
