import { afterEach, describe, expect, it, vi } from "vitest"

import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { detectHost, getHostBinding } from "../src/index.ts"

const hostVariables = [
  "VITEHUB_HOST",
  "NITRO_PRESET",
  "SERVER_PRESET",
  "CF_PAGES",
  "WORKERS_CI",
  "NETLIFY",
  "NOW_BUILDER",
  "VERCEL",
  "VERCEL_ENV",
  "DENO_DEPLOY",
  "DENO_DEPLOYMENT_ID",
]

const host = globalThis as { __env__?: Record<string, unknown> }

afterEach(() => {
  delete host.__env__
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("getHostBinding", () => {
  it("returns RUNTIME_HOST_BINDINGS_UNAVAILABLE without host bindings", () => {
    const [error, binding] = getHostBinding("VIDEOS")
    expect(binding).toBeUndefined()
    expect(error).toMatchObject({
      code: "RUNTIME_HOST_BINDINGS_UNAVAILABLE",
      docs: "https://vitehub.dev/docs/development/diagnostics/runtime_host_bindings_unavailable",
    })
    expect(error?.why).toContain("\"VIDEOS\"")
  })

  it("reads the bindings that Nitro puts on the Worker global, as in a Schedule", () => {
    const bucket = { get: () => null }
    host.__env__ = { VIDEOS: bucket, ADMIN_EMAILS: "a@example.com" }
    expect(getHostBinding("VIDEOS")).toEqual([undefined, bucket])
    expect(getHostBinding("ADMIN_EMAILS")).toEqual([undefined, "a@example.com"])
  })

  it("returns RUNTIME_HOST_BINDING_NOT_FOUND for a name that the Worker lacks", () => {
    host.__env__ = { VIDEOS: {} }
    const [error] = getHostBinding("ASSETS")
    expect(error?.code).toBe("RUNTIME_HOST_BINDING_NOT_FOUND")
    expect(error?.why).toBe("The Worker has no binding named \"ASSETS\".")
  })

  it("does not read inherited properties as bindings", () => {
    host.__env__ = {}
    expect(getHostBinding("toString")[0]?.code).toBe("RUNTIME_HOST_BINDING_NOT_FOUND")
  })

  it("reads the bindings of a Queue or Workflow run", async () => {
    host.__env__ = { QUEUE_ONLY: "global" }
    await runWithActiveCloudflareEnv({ QUEUE_ONLY: "scoped" }, async () => {
      await Promise.resolve()
      expect(getHostBinding("QUEUE_ONLY")).toEqual([undefined, "scoped"])
    })
  })

  it("prefers the bindings of the request event", () => {
    host.__env__ = { ASSETS: "global" }
    const request = Object.assign(new Request("https://example.com"), { runtime: { cloudflare: { env: { ASSETS: "request" } } } })
    // An H3 2 event without the Standard Context plugin has the host bindings on `req.runtime`.
    expect(getHostBinding("ASSETS", { req: request })).toEqual([undefined, "request"])
  })

  it("reads Standard Context bindings", () => {
    const request = new Request("https://example.com")
    const event = { "~standard": { req: request, runtime: { cloudflare: { env: { DB: "d1" } } }, context: {} } }
    expect(getHostBinding("DB", event)).toEqual([undefined, "d1"])
  })

  it("reads the env of a host context", () => {
    expect(getHostBinding("DB", { env: { DB: "d1" } })).toEqual([undefined, "d1"])
  })

  it("falls back to the active bindings when the event has none", () => {
    host.__env__ = { DB: "global" }
    // A Node dev event has no Cloudflare runtime.
    expect(getHostBinding("DB", { req: new Request("https://example.com") })).toEqual([undefined, "global"])
  })
})

describe("detectHost", () => {
  it.each([
    [{ WORKERS_CI: "1" }, "cloudflare"],
    [{ VERCEL: "1" }, "vercel"],
    [{ NETLIFY: "true" }, "netlify"],
    [{ DENO_DEPLOYMENT_ID: "abc123" }, "deno"],
  ] as const)("detects the host from the provider variables in %o", (env, expected) => {
    expect(detectHost(env)).toBe(expected)
  })

  it("prefers VITEHUB_HOST, then NITRO_PRESET and SERVER_PRESET, over provider variables", () => {
    expect(detectHost({ VITEHUB_HOST: "netlify", NITRO_PRESET: "vercel", VERCEL: "1" })).toBe("netlify")
    expect(detectHost({ NITRO_PRESET: "cloudflare_module", SERVER_PRESET: "vercel", VERCEL: "1" })).toBe("cloudflare")
    expect(detectHost({ SERVER_PRESET: "node-server", VERCEL: "1" })).toBe("node")
  })

  it("returns undefined without a known host, and skips empty values and Cloudflare Pages", () => {
    expect(detectHost({})).toBeUndefined()
    expect(detectHost({ VITEHUB_HOST: " ", VERCEL: "" })).toBeUndefined()
    expect(detectHost({ CF_PAGES: "1" })).toBeUndefined()
  })

  it("reads process.env by default", () => {
    for (const name of hostVariables) vi.stubEnv(name, "")
    vi.stubEnv("NETLIFY", "true")
    expect(detectHost()).toBe("netlify")
  })

  it("returns cloudflare inside a Worker", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
    expect(detectHost({})).toBe("cloudflare")
  })
})
