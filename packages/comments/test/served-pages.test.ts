import { describe, expect, it, vi } from "vitest"

import { defineComments } from "../src/index.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"

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
      web: { request: new Request("https://site.test/?vitehub") },
      node: { res: { getHeader: (name: string) => name === "content-security-policy" ? nodePolicy : undefined } },
    }, response)
    const html = await response.body.text()
    if (nonce) expect(html).toContain(`nonce="${nonce}"`)
    else expect(html).not.toContain(" nonce=")
    expect(response.body.headers.get("content-security-policy")).toBe(policy ?? null)
    expect(response.body.headers.get("cache-control")).toBe("private, no-store")
  })
})
