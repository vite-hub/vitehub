import { describe, expect, it } from "vitest"

import { injectOverlay, scriptNonce, wantsCommentMode } from "../src/runtime/plugin.ts"

function streamed(chunks: string[], type = "text/html; charset=utf-8"): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { "content-type": type, "content-length": "999" } })
}

describe("overlay injection", () => {
  it("asks for comment mode with ?comments or the hint cookie, never on Console or API routes", () => {
    expect(wantsCommentMode(new Request("http://site.test/pricing?comments"))).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/", { headers: { cookie: "a=1; vitehub-comments=1" } }))).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/"))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/_vitehub/content?comments"))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/api/x?comments"))).toBe(false)
  })

  it("adds the script before </body>, also when the tag spans two chunks", async () => {
    const response = injectOverlay(streamed(["<html><body><h1>Hi</h1></bo", "dy></html>"]), "/o.js")
    expect(await response.text()).toBe("<html><body><h1>Hi</h1><script type=\"module\" src=\"/o.js\" data-vitehub-comments></script></body></html>")
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it("gives the script the nonce of the page's Content Security Policy, which 'strict-dynamic' needs", async () => {
    const policy = "default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-a1B2+c/3=='; style-src 'self' 'nonce-style'"
    expect(scriptNonce(new Headers({ "content-security-policy": policy }))).toBe("a1B2+c/3==")
    expect(scriptNonce(new Headers({ "content-security-policy": "default-src 'self' 'nonce-xyz'" }))).toBe("xyz")
    expect(scriptNonce(new Headers())).toBeUndefined()
    const page = new Response("<body></body>", { headers: { "content-type": "text/html", "content-security-policy": policy } })
    expect(await injectOverlay(page, "/o.js").text()).toBe("<body><script type=\"module\" src=\"/o.js\" nonce=\"a1B2+c/3==\" data-vitehub-comments></script></body>")
  })

  it("appends the script to HTML without a body tag, and leaves other responses alone", async () => {
    expect(await injectOverlay(streamed(["<h1>Hi</h1>"]), "/o.js").text()).toBe("<h1>Hi</h1><script type=\"module\" src=\"/o.js\" data-vitehub-comments></script>")
    const json = streamed(["{}"], "application/json")
    expect(injectOverlay(json, "/o.js")).toBe(json)
  })
})
