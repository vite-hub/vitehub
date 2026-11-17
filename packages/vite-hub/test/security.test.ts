import { H3, readBody } from "h3"
import { describe, expect, it } from "vitest"

import { addSecurityHeaders, installSecurity } from "../src/_internal/runtime/security.ts"
import { renderRequestPolicyNitroPlugin } from "../src/request-policy-vite.ts"
import { addSecurityHeadersToHeadersFile, addSecurityHeadersToVercelConfig, parseByteSize, resolveSecurityHeaders, resolveSecurityPolicy } from "../src/security-vite.ts"

const defaults = resolveSecurityHeaders(true)

function streamed(text: string, chunk = 4): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close()
      controller.enqueue(bytes.slice(offset, offset += chunk))
    },
  })
}

describe("security.headers", () => {
  it("resolves the default set, changes, adds, and removes headers", () => {
    expect(defaults.map(([name]) => name)).toEqual(["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"])
    const custom = resolveSecurityHeaders({ "permissions-policy": "microphone=(self)", "X-Frame-Options": false, "X-Robots-Tag": "noindex" })
    expect(custom).toEqual([
      ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
      ["X-Content-Type-Options", "nosniff"],
      ["Referrer-Policy", "strict-origin-when-cross-origin"],
      ["permissions-policy", "microphone=(self)"],
      ["X-Robots-Tag", "noindex"],
    ])
    expect(resolveSecurityHeaders(false)).toEqual([])
    expect(resolveSecurityPolicy({})).toBeUndefined()
    expect(resolveSecurityPolicy({ headers: false })).toBeUndefined()
  })

  it("refuses a header that a response cannot hold", () => {
    expect(() => resolveSecurityHeaders({ "X-Robots-Tag": "noindex\r\nSet-Cookie: a=1" })).toThrow(expect.objectContaining({ name: "VITE_HUB_SECURITY_HEADER_INVALID" }))
    expect(() => resolveSecurityHeaders({ "Bad Name": "1" })).toThrow(expect.objectContaining({ name: "VITE_HUB_SECURITY_HEADER_INVALID" }))
  })

  it("adds only the headers that a response does not set itself", () => {
    const own = addSecurityHeaders(new Response("ok", { headers: { "x-frame-options": "DENY" } }), defaults)
    expect(own.headers.get("x-frame-options")).toBe("DENY")
    expect(own.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("copies a response with immutable headers and leaves a WebSocket upgrade alone", async () => {
    const redirect = addSecurityHeaders(Response.redirect("https://app.test/next", 302), defaults)
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("https://app.test/next")
    expect(redirect.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    const upgrade = { status: 101, headers: new Headers() } as Response
    expect(addSecurityHeaders(upgrade, defaults)).toBe(upgrade)
  })
})

describe("security.maxBodySize", () => {
  it("reads bytes and sizes", () => {
    expect(parseByteSize(2048)).toBe(2048)
    expect(parseByteSize("1mb")).toBe(1024 * 1024)
    expect(parseByteSize("500KB")).toBe(500 * 1024)
    expect(parseByteSize("1.5 kb")).toBe(1536)
    for (const value of [0, -1, 1.5, "1 megabyte", "", "mb", Number.POSITIVE_INFINITY]) {
      expect(() => parseByteSize(value)).toThrow(expect.objectContaining({ name: "VITE_HUB_SECURITY_MAX_BODY_SIZE_INVALID" }))
    }
  })

  function app() {
    const h3 = new H3().post("/notes", async event => ({ body: await readBody(event) }))
    const nitroApp = { fetch: (request: Request) => h3.fetch(request) }
    installSecurity(nitroApp, { headers: defaults, maxBodySize: 16 })
    return nitroApp.fetch
  }

  it("answers 413 with the catalog code before the route runs when Content-Length is over the limit", async () => {
    const response = await app()(new Request("http://app.test/notes", { method: "POST", headers: { "content-length": "35" }, body: JSON.stringify({ text: "far too long for the limit" }) }))
    expect(response.status).toBe(413)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await response.json()).toMatchObject({ status: 413, data: { code: "VITE_HUB_REQUEST_BODY_TOO_LARGE", docs: expect.stringContaining("https://vitehub.dev/") } })
  })

  it("counts a body without Content-Length while the route reads it", async () => {
    const fetch = app()
    const small = await fetch(new Request("http://app.test/notes", { method: "POST", body: streamed("{\"a\":1}"), duplex: "half" } as RequestInit))
    expect(await small.json()).toEqual({ body: { a: 1 } })
    const large = await fetch(new Request("http://app.test/notes", { method: "POST", body: streamed("{\"text\":\"far too long for the limit\"}"), duplex: "half" } as RequestInit))
    expect(large.status).toBe(413)
    expect(large.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(await large.json()).toMatchObject({ data: { code: "VITE_HUB_REQUEST_BODY_TOO_LARGE" } })
  })
})

describe("generated output", () => {
  it("renders the security plugin after the request policy, without HSTS in development", () => {
    const code = renderRequestPolicyNitroPlugin({ trustProxy: false, sameOriginWrites: { exclude: [] } }, { headers: defaults, maxBodySize: 1024 })
    expect(code.indexOf("installRequestPolicy(nitroApp")).toBeLessThan(code.indexOf("installSecurity(nitroApp"))
    expect(code).toContain("maxBodySize: 1024")
    const dev = /import\.meta\.dev \? (\[.*?\]) :/.exec(code)![1]!
    expect(dev).not.toContain("Strict-Transport-Security")
    expect(renderRequestPolicyNitroPlugin({ trustProxy: false, sameOriginWrites: false }, { headers: defaults })).not.toContain("request-policy")
  })

  it("adds a base rule to _headers without the headers that the file already sets", () => {
    const file = "/embed/*\n  X-Frame-Options: ALLOWALL\n"
    expect(addSecurityHeadersToHeadersFile(file, defaults, "/docs/")).toBe([
      "/embed/*",
      "  X-Frame-Options: ALLOWALL",
      "/docs/*",
      "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      "  Permissions-Policy: camera=(), geolocation=(), microphone=()",
      "",
    ].join("\n"))
    expect(addSecurityHeadersToHeadersFile("", [["X-Robots-Tag", "noindex"]], "/")).toBe("/*\n  X-Robots-Tag: noindex\n")
  })

  it("adds the headers to static files in the Vercel hit phase", () => {
    const config = { routes: [{ src: "/(.*)", headers: { "Referrer-Policy": "no-referrer" }, continue: true }, { handle: "filesystem" }, { src: "/(.*)", dest: "/__server" }] }
    const routes = addSecurityHeadersToVercelConfig(config, defaults).routes!
    expect(routes.slice(3)).toEqual([
      { handle: "hit" },
      { src: "/(.*)", continue: true, headers: Object.fromEntries(defaults.filter(([name]) => name !== "Referrer-Policy")) },
    ])
  })
})
