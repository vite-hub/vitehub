import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import { normalizeRequestBody } from "../server/utils/normalize-request-body"

describe("normalizeRequestBody", () => {
  it("adds text/json readers to node-style requests", async () => {
    const request = Readable.from([JSON.stringify({ ok: true })]) as Readable & {
      body?: unknown
      text?: () => Promise<string>
      json?: () => Promise<unknown>
    }

    normalizeRequestBody(request)

    expect(await request.text?.()).toBe("{\"ok\":true}")
    await expect(request.json?.()).resolves.toEqual({ ok: true })
  })

  it("reuses pre-parsed bodies", async () => {
    const request = {
      body: { provider: "vercel" },
    } as {
      body: unknown
      text?: () => Promise<string>
      json?: () => Promise<unknown>
      arrayBuffer?: () => Promise<ArrayBuffer>
    }

    normalizeRequestBody(request)

    expect(await request.text?.()).toBe("{\"provider\":\"vercel\"}")
    await expect(request.json?.()).resolves.toEqual({ provider: "vercel" })
    await expect(request.arrayBuffer?.()).resolves.toBeInstanceOf(ArrayBuffer)
  })
})
