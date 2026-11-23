import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3Event } from "h3"
import { describe, expect, it } from "vitest"

import { getRequestIP } from "h3"

import { getStandardContext, installStandardContext } from "../src/_internal/runtime/internal/h3.ts"

import { installRequestPolicy, isCrossOriginWrite, trustForwardedProto, trustProxyHeaders } from "../src/_internal/runtime/request-policy.ts"
import { renderRequestPolicyNitroPlugin, requestPolicyVitePlugin } from "../src/request-policy-vite.ts"

function post(url: string, headers: Record<string, string>, method = "POST"): Request {
  return new Request(url, { method, headers })
}

describe("trustProxy", () => {
  it("sets the request URL to https when the first X-Forwarded-Proto value is https", () => {
    const event = new H3Event(new Request("http://app.test/api/me", { headers: { "x-forwarded-proto": "https, http" } }))
    trustForwardedProto(event)
    expect(event.url.href).toBe("https://app.test/api/me")
  })

  it("keeps the URL without the header, with another value, and never downgrades https", () => {
    for (const [url, header] of [["http://app.test/", undefined], ["http://app.test/", "http"], ["http://app.test/", "wss"], ["https://app.test/", "http"]] as const) {
      const event = new H3Event(new Request(url, header ? { headers: { "x-forwarded-proto": header } } : {}))
      trustForwardedProto(event)
      expect(event.url.href).toBe(url)
    }
  })

  it("reads the client address from the last X-Forwarded-For value, which the proxy adds", () => {
    const request = new Request("http://app.test/api/auth/sign-in/email", { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } })
    Object.defineProperty(request, "ip", { configurable: true, value: "127.0.0.1" })
    const event = new H3Event(request)
    trustProxyHeaders(event)
    installStandardContext(event)
    expect(getStandardContext(event).runtime?.clientAddress).toBe("198.51.100.7")
    expect(getRequestIP(event)).toBe("198.51.100.7")
  })

  it("keeps the peer address without X-Forwarded-For", () => {
    for (const header of [undefined, "", " , "]) {
      const request = new Request("http://app.test/", header === undefined ? {} : { headers: { "x-forwarded-for": header } })
      Object.defineProperty(request, "ip", { configurable: true, value: "192.0.2.4" })
      const event = new H3Event(request)
      trustProxyHeaders(event)
      installStandardContext(event)
      expect(getStandardContext(event).runtime?.clientAddress).toBe("192.0.2.4")
    }
  })

  it("never reads X-Forwarded-Host", () => {
    const event = new H3Event(new Request("http://app.test/", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.test" } }))
    trustForwardedProto(event)
    expect(event.url.host).toBe("app.test")
  })
})

describe("sameOriginWrites", () => {
  const cookie = { cookie: "session=1" }

  it("refuses writes with cookies from another origin or another site", () => {
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, origin: "https://evil.test" }))).toBe(true)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, "sec-fetch-site": "cross-site" }))).toBe(true)
    // A sibling subdomain is same-site, so SameSite=Lax cookies still go with the request.
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, "sec-fetch-site": "same-site", origin: "https://files.app.test" }))).toBe(true)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, "sec-fetch-site": "same-site" }))).toBe(true)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, origin: "https://evil.test" }, "DELETE"))).toBe(true)
  })

  it("lets same-origin writes, reads, and writes without cookies through", () => {
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, origin: "https://app.test", "sec-fetch-site": "same-origin" }))).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, "sec-fetch-site": "none" }))).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", cookie))).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { ...cookie, origin: "https://evil.test" }, "GET"))).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", { authorization: "Bearer token", origin: "https://evil.test", "sec-fetch-site": "cross-site" }))).toBe(false)
  })

  it("compares the Origin with the origin that a proxy forwards", () => {
    const proxied = { ...cookie, origin: "https://app.test", "x-forwarded-proto": "https" }
    expect(isCrossOriginWrite(post("http://app.test/api/notes", proxied))).toBe(false)
    expect(isCrossOriginWrite(post("http://app.test/api/notes", { ...cookie, origin: "https://app.test" }))).toBe(true)
  })

  it("skips excluded path prefixes and the paths below them only", () => {
    const exclude = ["/api/forms/contact", "/webhooks/"]
    const foreign = { ...cookie, origin: "https://evil.test" }
    expect(isCrossOriginWrite(post("https://app.test/api/forms/contact", foreign), exclude)).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/api/forms/contact/step", foreign), exclude)).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/webhooks", foreign), exclude)).toBe(false)
    expect(isCrossOriginWrite(post("https://app.test/api/forms/contacts", foreign), exclude)).toBe(true)
    expect(isCrossOriginWrite(post("https://app.test/api/notes", foreign), exclude)).toBe(true)
  })
})

describe("installRequestPolicy", () => {
  function nitroApp() {
    const requestHooks: unknown[] = [() => {}]
    const calls: Request[] = []
    const app = {
      fetch: async (request: Request) => {
        calls.push(request)
        return new Response("ok")
      },
      hooks: { _hooks: { request: requestHooks }, hook: (_name: "request", handler: unknown) => requestHooks.push(handler) },
    }
    return { app, calls, requestHooks }
  }

  it("answers a cross-origin write with 403 before the app runs", async () => {
    const { app, calls } = nitroApp()
    installRequestPolicy(app, { sameOriginWrites: { exclude: [] } })

    const refused = await app.fetch(post("https://app.test/api/notes", { cookie: "session=1", origin: "https://evil.test" }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: "VITEHUB_CROSS_ORIGIN_WRITE" } })
    expect(calls).toHaveLength(0)

    expect((await app.fetch(post("https://app.test/api/notes", { cookie: "session=1", origin: "https://app.test" }))).status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it("keeps the host's client address when only forwarded protocol is trusted", () => {
    const { app, requestHooks } = nitroApp()
    installRequestPolicy(app, { trustProxy: true })
    const request = new Request("http://app.test/", {
      headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
    })
    Object.defineProperty(request, "ip", { configurable: true, value: "198.51.100.7" })
    const event = new H3Event(request)
    const [hook] = requestHooks
    if (typeof hook !== "function") throw new TypeError("Missing request hook")
    hook(event)
    expect(event.url.protocol).toBe("https:")
    expect(getRequestIP(event)).toBe("198.51.100.7")
  })

  it("puts the trustProxy hook before the request hooks of other plugins, and changes nothing when both are off", () => {
    const { app, requestHooks } = nitroApp()
    const fetch = app.fetch
    installRequestPolicy(app, { trustProxy: false, sameOriginWrites: false })
    expect(app.fetch).toBe(fetch)
    expect(requestHooks).toHaveLength(1)

    installRequestPolicy(app, { trustProxy: true, trustProxyAddress: true, sameOriginWrites: false })
    expect(requestHooks[0]).toBe(trustProxyHeaders)
    expect(app.fetch).toBe(fetch)
  })
})

describe("request policy Vite plugin", () => {
  it("passes the resolved options to the generated Nitro plugin", () => {
    expect(renderRequestPolicyNitroPlugin({ trustProxy: true, sameOriginWrites: { exclude: ["/hooks"] } }))
      .toContain(`installRequestPolicy(nitroApp, {"trustProxy":true,"sameOriginWrites":{"exclude":["/hooks"]}})`)
  })

  it.each(["node", "cloudflare", "netlify", "vercel", "deno"] as const)("registers the %s policy before configured async plugins", async (host) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-request-policy-"))
    try {
      const config: { root: string, nitro?: { plugins?: string[] } } = { root, nitro: { plugins: ["async-plugin.mjs"] } }
      await (requestPolicyVitePlugin(host, { trustProxy: true, sameOriginWrites: true }, undefined).config as (config: object, env: object) => Promise<void>)(config, { command: "build", mode: "production" })
      const file = join(root, ".vitehub/nitro/request-policy.mjs")
      expect(config.nitro?.plugins).toEqual([file, "async-plugin.mjs"])
      expect(await readFile(file, "utf8")).toContain(`{"trustProxy":true,"trustProxyAddress":${host === "node"},"sameOriginWrites":{"exclude":[]}}`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
