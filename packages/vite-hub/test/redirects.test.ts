import { describe, expect, it } from "vitest"

import { canonicalRedirect, installRedirects, withCloudflareRedirects } from "../src/_internal/runtime/redirects.ts"
import { cloudflareRedirectsAssets, defaultPreviewHosts, resolveRedirectsPolicy } from "../src/redirects-vite.ts"

import type { RedirectsPolicy } from "../src/_internal/runtime/redirects.ts"

const policy = (options: Partial<RedirectsPolicy>): RedirectsPolicy => ({ previewHosts: [...defaultPreviewHosts], ...options })

function redirect(url: string, options: Partial<RedirectsPolicy>, init: { method?: string, headers?: Record<string, string> } = {}) {
  const response = canonicalRedirect(new Request(url, { method: init.method ?? "GET", headers: init.headers }), policy(options))
  return response && { status: response.status, location: response.headers.get("location") }
}

describe("canonicalRedirect", () => {
  it("sends other hosts and http to the canonical origin in one redirect, with the path and query", () => {
    expect(redirect("http://www.example.com/pricing?plan=pro", { host: "example.com", https: true })).toEqual({ status: 301, location: "https://example.com/pricing?plan=pro" })
    expect(redirect("https://next.example.com/", { host: "example.com" })).toEqual({ status: 301, location: "https://example.com/" })
    expect(redirect("http://example.com:8080/a", { https: true })).toEqual({ status: 301, location: "https://example.com/a" })
    expect(redirect("https://example.com/pricing", { host: "example.com", https: true })).toBeUndefined()
  })

  it("answers 308 to other methods, which keeps the method and the body", () => {
    expect(redirect("https://www.example.com/api/notes", { host: "example.com" }, { method: "POST" })).toEqual({ status: 308, location: "https://example.com/api/notes" })
  })

  it("reads the client origin from a proxy, so a TLS proxy does not loop", () => {
    expect(redirect("http://10.0.0.5:3000/a", { host: "example.com", https: true }, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.com" } })).toBeUndefined()
    expect(redirect("http://10.0.0.5:3000/a", { host: "example.com", https: true }, { headers: { "x-forwarded-proto": "http", "x-forwarded-host": "www.example.com" } }))
      .toEqual({ status: 301, location: "https://example.com/a" })
  })

  it("keeps local names, IP addresses, and preview hosts", () => {
    for (const url of ["http://localhost:3000/a", "http://app.localhost/a", "http://127.0.0.1:3000/a", "http://[::1]:3000/a", "http://web:3000/a", "http://shop.acme.workers.dev/a", "http://pr-4.vercel.app/a"]) {
      expect(redirect(url, { host: "example.com", https: true }), url).toBeUndefined()
    }
    expect(redirect("http://staging.example.com/a", { host: "example.com", previewHosts: ["staging.example.com"] })).toBeUndefined()
    expect(redirect("http://a.b.example.net/a", { host: "example.com", previewHosts: ["*.example.net"] })).toBeUndefined()
  })

  it("adds or removes the trailing slash of page paths only", () => {
    expect(redirect("https://example.com/docs/intro/?x=1", { trailingSlash: "remove" })).toEqual({ status: 301, location: "https://example.com/docs/intro?x=1" })
    expect(redirect("https://example.com/docs/intro", { trailingSlash: "add" })).toEqual({ status: 301, location: "https://example.com/docs/intro/" })
    for (const path of ["/", "/api/notes/", "/_nuxt/entry.js/", "/robots.txt", "/feed.xml/"]) {
      expect(redirect(`https://example.com${path}`, { trailingSlash: "remove" }), path).toBeUndefined()
      expect(redirect(`https://example.com${path.replace(/\/$/, "")}`, { trailingSlash: "add" }), path).toBeUndefined()
    }
    // Webhooks and API clients do not always follow a redirect.
    expect(redirect("https://example.com/hooks/stripe/", { trailingSlash: "remove" }, { method: "POST" })).toBeUndefined()
    // Local hosts keep their origin, but the path still becomes canonical.
    expect(redirect("http://localhost:3000/docs/", { trailingSlash: "remove", host: "example.com" })).toEqual({ status: 301, location: "http://localhost:3000/docs" })
  })

  it("always answers with an absolute URL", () => {
    expect(redirect("https://example.com//evil/", { trailingSlash: "remove" })).toEqual({ status: 301, location: "https://example.com//evil" })
  })
})

describe("installRedirects", () => {
  it("answers the redirect before the app runs", async () => {
    const seen: string[] = []
    const app = { fetch: (request: Request) => { seen.push(request.url); return new Response("app") } }
    installRedirects(app, policy({ host: "example.com" }))
    const moved = await app.fetch(new Request("https://www.example.com/a"))
    expect([moved.status, moved.headers.get("location")]).toEqual([301, "https://example.com/a"])
    expect(await (await app.fetch(new Request("https://example.com/a"))).text()).toBe("app")
    expect(seen).toEqual(["https://example.com/a"])
  })
})

describe("withCloudflareRedirects", () => {
  const files: Record<string, string> = { "/about": "<h1>About</h1>" }
  const env = { ASSETS: { fetch: async (request: Request) => new Response(files[new URL(request.url).pathname] ?? "not found", { status: files[new URL(request.url).pathname] ? 200 : 404 }) } }
  const worker = withCloudflareRedirects({ fetch: async () => new Response("app"), scheduled: () => {} }, policy({ host: "example.com", https: true }))

  it("redirects static files, then serves them, and lets the app answer the rest", async () => {
    const moved = await worker.fetch(new Request("http://www.example.com/about"), env, {})
    expect([moved.status, moved.headers.get("location")]).toEqual([301, "https://example.com/about"])
    expect(await (await worker.fetch(new Request("https://example.com/about"), env, {})).text()).toBe("<h1>About</h1>")
    expect(await (await worker.fetch(new Request("https://example.com/dashboard"), env, {})).text()).toBe("app")
    expect(await (await worker.fetch(new Request("https://example.com/about", { method: "POST" }), env, {})).text()).toBe("app")
    expect(worker.scheduled).toBeTypeOf("function")
  })
})

describe("resolveRedirectsPolicy", () => {
  it("resolves nothing when no redirect is set", () => {
    expect(resolveRedirectsPolicy(undefined)).toBeUndefined()
    expect(resolveRedirectsPolicy({})).toBeUndefined()
    expect(resolveRedirectsPolicy({ https: false, previewHosts: ["staging.example.com"] })).toBeUndefined()
  })

  it("normalizes the host and adds the preview hosts to the defaults", () => {
    expect(resolveRedirectsPolicy({ host: " Example.COM ", https: true, trailingSlash: "remove", previewHosts: ["Staging.example.com"] })).toEqual({
      host: "example.com",
      https: true,
      trailingSlash: "remove",
      previewHosts: [...defaultPreviewHosts, "staging.example.com"],
    })
  })

  it("fails on a host with a scheme, a port, or a path", () => {
    for (const host of ["https://example.com", "example.com:443", "example.com/", "localhost", ""]) {
      expect(() => resolveRedirectsPolicy({ host }), host).toThrow(expect.objectContaining({ name: "VITE_HUB_REDIRECTS_HOST_INVALID" }))
    }
    expect(() => resolveRedirectsPolicy({ host: "example.com", previewHosts: ["https://staging.example.com"] })).toThrow(expect.objectContaining({ name: "VITE_HUB_REDIRECTS_PREVIEW_HOST_INVALID" }))
    // SAFETY: a JavaScript config can pass any value.
    expect(() => resolveRedirectsPolicy({ trailingSlash: "strip" as "remove" })).toThrow(expect.objectContaining({ name: "VITE_HUB_REDIRECTS_TRAILING_SLASH_INVALID" }))
  })
})

describe("cloudflareRedirectsAssets", () => {
  const nitro = { baseURL: "/", publicAssets: [{ baseURL: "/", fallthrough: true }, { baseURL: "/_nuxt/builds/meta/", fallthrough: false }, { baseURL: "/_nuxt/", fallthrough: false }, { baseURL: "/_nuxt", fallthrough: false }, { baseURL: "/_nuxt-icons", fallthrough: false }] }

  it("runs the Worker first for every path except the hashed build assets", () => {
    expect(cloudflareRedirectsAssets(policy({ host: "example.com" }), nitro, {})).toEqual({ run_worker_first: ["/*", "!/_nuxt/*", "!/_nuxt-icons/*"] })
    expect(cloudflareRedirectsAssets(policy({ trailingSlash: "remove" }), { ...nitro, baseURL: "/docs" }, {})).toEqual({ run_worker_first: ["/docs/*", "!/docs/_nuxt/*", "!/docs/_nuxt-icons/*"], html_handling: "drop-trailing-slash" })
    expect(cloudflareRedirectsAssets(policy({ trailingSlash: "add" }), nitro, {}).html_handling).toBe("force-trailing-slash")
  })

  it("keeps the keys that the app sets", () => {
    expect(cloudflareRedirectsAssets(policy({ trailingSlash: "add" }), nitro, { run_worker_first: true, html_handling: "none" })).toEqual({})
  })
})
