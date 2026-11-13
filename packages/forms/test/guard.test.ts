import { describe, expect, it, vi } from "vitest"

import { guardRequest } from "../src/guard.ts"

const origin = "https://site.test"

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/_vitehub/comments/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  })
}

function streamedPost(text: string, type: string) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + 1024))
      offset = Math.min(offset + 1024, bytes.byteLength)
    },
    cancel,
  }, { highWaterMark: 0 })
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "content-type": type, origin },
    body,
    duplex: "half",
  }
  return { request: new Request(`${origin}/api/_vitehub/comments/threads`, init), cancel }
}

describe("guardRequest", () => {
  it("returns the fields, page, and anchor of a request that passes", async () => {
    const [stopped, guarded] = await guardRequest(post({ body: "Hi", _page: "/docs", _anchor: { selector: "p", exact: "Hi", prefix: "", suffix: "" }, website: "" }), { key: "comments:create" })
    expect(stopped).toBeUndefined()
    expect(guarded).toEqual({ body: { body: "Hi" }, page: "/docs", anchor: { selector: "p", exact: "Hi", prefix: "", suffix: "" }, html: false })
  })

  it("asks the rate limit with the caller's key and policy", async () => {
    const rateLimit = vi.fn(async () => ({ allowed: false }))
    const [stopped] = await guardRequest(post({ body: "Hi" }), { key: "comments:guest", rateLimit: { limit: 10, window: "1h" } }, { rateLimit })
    expect(stopped?.status).toBe(429)
    expect(rateLimit).toHaveBeenCalledWith(expect.any(Request), "comments:guest", { limit: 10, window: "1h" })
  })

  it("runs the app check before the rate limit and body parsing", async () => {
    const rateLimit = vi.fn(async () => ({ allowed: true }))
    const request = post({ body: "Hi" })
    // The check gets a copy, so it may read the body and the guard still reads it.
    const check = vi.fn(async (incoming: Request) => (await incoming.json()).body === "Hi" ? { status: 401, message: "Sign in." } : undefined)
    const [stopped] = await guardRequest(request, { key: "comments:create", check }, { rateLimit })
    expect(stopped?.status).toBe(401)
    expect(await stopped?.json()).toEqual({ message: "Sign in." })
    expect(rateLimit).not.toHaveBeenCalled()
    const [passed, guarded] = await guardRequest(post({ body: "Yo" }), { key: "comments:create", check }, { rateLimit })
    expect([passed, guarded?.body]).toEqual([undefined, { body: "Yo" }])
    // A browser form without JavaScript goes back to its page.
    const html = new Request(`${origin}/api/_vitehub/forms/contact`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin, referer: `${origin}/pricing` }, body: "message=Hi" })
    const [back] = await guardRequest(html, { key: "form:contact", check: () => ({ status: 403, message: "No." }) })
    expect([back?.status, back?.headers.get("location")]).toEqual([303, "/pricing?form=error"])
  })

  it.each(["text", "json", "formData"] as const)("bounds a chunked body before the app check can call %s()", async (read) => {
    const text = "x".repeat(8192)
    const form = read === "formData"
    const { request, cancel } = streamedPost(form ? `body=${text}` : JSON.stringify({ body: text }), form ? "application/x-www-form-urlencoded" : "application/json")
    const check = vi.fn(async (incoming: Request) => {
      await incoming[read]()
      return { status: 401, message: "Sign in." }
    })
    const rateLimit = vi.fn(async () => ({ allowed: true }))
    const [stopped] = await guardRequest(request, { key: "comments:create", maxBytes: 2048, check }, { rateLimit })
    expect(stopped?.status).toBe(413)
    expect(check).not.toHaveBeenCalled()
    expect(rateLimit).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(["urlencoded", "multipart"])("lets the app check read bounded %s data before the guard parses it", async (encoding) => {
    const body = encoding === "multipart" ? new FormData() : new URLSearchParams()
    body.set("body", "Hi")
    const request = new Request(`${origin}/write`, { method: "POST", headers: { origin }, body })
    const check = vi.fn(async (incoming: Request) => {
      expect(incoming.url).toBe(request.url)
      expect(incoming.headers.get("origin")).toBe(origin)
      expect((await incoming.formData()).get("body")).toBe("Hi")
      return undefined
    })
    const [stopped, guarded] = await guardRequest(request, { key: "comments:create", maxBytes: 2048, check })
    expect(stopped).toBeUndefined()
    expect(guarded?.body).toEqual({ body: "Hi" })
    expect(check).toHaveBeenCalledOnce()
  })

  it("preserves multipart file bytes for an app check that refuses the request", async () => {
    const bytes = new Uint8Array([0, 128, 255])
    const body = new FormData()
    body.set("file", new Blob([bytes]), "sample.bin")
    const request = new Request(`${origin}/write`, { method: "POST", headers: { origin }, body })
    const check = async (incoming: Request) => {
      const file = (await incoming.formData()).get("file")
      expect(file).toBeInstanceOf(File)
      if (file instanceof File) expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
      return { status: 403, message: "No files." }
    }
    const rateLimit = vi.fn(async () => ({ allowed: true }))
    const [stopped] = await guardRequest(request, { key: "comments:create", maxBytes: 2048, check }, { rateLimit })
    expect(stopped?.status).toBe(403)
    expect(rateLimit).not.toHaveBeenCalled()
  })

  it("stops other origins, a filled honeypot, and large bodies, and can turn the honeypot off", async () => {
    expect((await guardRequest(post({}, { origin: "https://evil.test" }), { key: "k" }))[0]?.status).toBe(403)
    expect((await guardRequest(post({ website: "x" }), { key: "k" }))[0]?.status).toBe(202)
    expect((await guardRequest(post({ text: "x".repeat(3000) }), { key: "k", maxBytes: 2048 }))[0]?.status).toBe(413)
    const [, kept] = await guardRequest(post({ website: "https://ada.dev" }), { key: "k", honeypot: false })
    expect(kept?.body).toEqual({ website: "https://ada.dev" })
  })
})
