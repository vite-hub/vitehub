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

  it("runs the app check before the rate limit and the body", async () => {
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

  it("stops other origins, a filled honeypot, and large bodies, and can turn the honeypot off", async () => {
    expect((await guardRequest(post({}, { origin: "https://evil.test" }), { key: "k" }))[0]?.status).toBe(403)
    expect((await guardRequest(post({ website: "x" }), { key: "k" }))[0]?.status).toBe(202)
    expect((await guardRequest(post({ text: "x".repeat(3000) }), { key: "k", maxBytes: 2048 }))[0]?.status).toBe(413)
    const [, kept] = await guardRequest(post({ website: "https://ada.dev" }), { key: "k", honeypot: false })
    expect(kept?.body).toEqual({ website: "https://ada.dev" })
  })
})
