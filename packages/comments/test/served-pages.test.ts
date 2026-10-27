import { readFileSync } from "node:fs"
import { compileFunction } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { defineComments } from "../src/index.ts"
import { defineCommentsPlugin, wantsCommentMode } from "../src/runtime/plugin.ts"

function responseHook() {
  let respond: ((event: unknown, response: { body?: unknown }) => void) | undefined
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    defineCommentsPlugin({ comments: defineComments(), database: () => undefined, overlay: "/overlay.js" })({
      hooks: { hook: (name: string, handler: typeof respond) => { if (name === "beforeResponse") respond = handler } },
    })
  }
  finally {
    warn.mockRestore()
  }
  return respond!
}

const nodePolicy = "script-src 'self' 'strict-dynamic' 'nonce-middleware'"

describe("Nitro 2 served pages", () => {
  it.each([
    { policy: undefined, nonce: "middleware" },
    { policy: "script-src 'strict-dynamic' 'nonce-returned'", nonce: "returned" },
    { policy: "script-src 'self'", nonce: undefined },
  ])("uses the effective CSP when the Response policy is $policy", async ({ policy, nonce }) => {
    const headers = new Headers({ "content-type": "text/html" })
    if (policy !== undefined) headers.set("content-security-policy", policy)
    const response = { body: new Response("<body>Page</body>", { headers }) }
    responseHook()({
      web: { request: new Request("https://site.test/?comments") },
      node: { res: { getHeader: (name: string) => name === "content-security-policy" ? nodePolicy : undefined } },
    }, response)
    const html = await response.body.text()
    if (nonce) expect(html).toContain(`nonce="${nonce}"`)
    else expect(html).not.toContain(" nonce=")
    expect(response.body.headers.get("content-security-policy")).toBe(policy ?? null)
    expect(response.body.headers.get("cache-control")).toBe("private, no-store")
  })

  it.each(["cookie", "query", "ordinary"])("runs the documented asset route for a %s navigation with validators", async (mode) => {
    const guide = readFileSync(new URL("../../../docs/content/docs/comments/configure.md", import.meta.url), "utf8")
    const source = /```ts \[server\/middleware\/pages.ts\]\n([\s\S]*?)```/.exec(guide)?.[1]
    if (!source) throw new Error("Missing served-page route example")
    const body = source.replace(/^import[^\n]+\n/gm, "").replace("export default", "return")
    const route: unknown = compileFunction(body, ["defineEventHandler", "wantsCommentMode", "Request", "Headers"])(
      <T>(handler: T) => handler, wantsCommentMode, Request, Headers,
    )
    if (typeof route !== "function") throw new Error("The documented route is not a handler")
    const assetFetch = vi.fn(async (request: Request) => {
      if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) return new Response(null, { status: 304 })
      return new Response("<body>Cached page</body>", { headers: { "content-type": "text/html", etag: '"page-v1"' } })
    })
    const headers = new Headers({ "if-none-match": '"page-v1"', "if-modified-since": "Mon, 26 Oct 2026 12:00:00 GMT" })
    if (mode === "cookie") headers.set("cookie", "vitehub-comments=1")
    const request = new Request(`https://site.test/guide/${mode === "query" ? "?comments" : ""}`, { headers })
    const file: unknown = await route({ context: { cloudflare: { request, env: { ASSETS: { fetch: assetFetch } } } } })
    if (!(file instanceof Response)) throw new Error("The asset route did not return a Response")
    const response = { body: file }
    responseHook()({ web: { request } }, response)
    const sent = assetFetch.mock.calls[0]![0]
    expect(request.headers.has("if-none-match")).toBe(true)
    if (mode === "ordinary") {
      expect(sent).toBe(request)
      expect(response.body.status).toBe(304)
    }
    else {
      expect(sent.headers.has("if-none-match")).toBe(false)
      expect(sent.headers.has("if-modified-since")).toBe(false)
      expect(sent.headers.get("cookie")).toBe(request.headers.get("cookie"))
      expect(response.body.status).toBe(200)
      expect(response.body.headers.get("cache-control")).toBe("private, no-store")
      expect(await response.body.text()).toContain('src="/overlay.js"')
    }
  })
})
