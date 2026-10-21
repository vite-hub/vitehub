import { describe, expect, it } from "vitest"

import { resolveHost, resolveHostPreset } from "../src/hosting.ts"

describe("host resolution", () => {
  it("prefers the Nitro preset over hosting and env", () => {
    const env = { NITRO_PRESET: "netlify", VITEHUB_HOSTING: "cloudflare" }
    expect(resolveHostPreset({ env, hosting: "deno-deploy", nitro: { preset: "vercel" } })).toBe("vercel")
    expect(resolveHost({ env, hosting: "deno-deploy", nitro: { preset: "vercel" } })).toBe("vercel")
  })

  it("uses the hosting option before env", () => {
    expect(resolveHost({ env: { NITRO_PRESET: "netlify" }, hosting: "cloudflare-module", nitro: {} })).toBe("cloudflare")
  })

  it("reads NITRO_PRESET, SERVER_PRESET, then VITEHUB_HOSTING", () => {
    expect(resolveHostPreset({ env: { NITRO_PRESET: "node-server", SERVER_PRESET: "vercel", VITEHUB_HOSTING: "netlify" } })).toBe("node-server")
    expect(resolveHostPreset({ env: { SERVER_PRESET: "vercel", VITEHUB_HOSTING: "netlify" } })).toBe("vercel")
    expect(resolveHost({ env: { VITEHUB_HOSTING: "deno-deploy" } })).toBe("deno")
  })

  it("skips empty values and returns undefined without a known host", () => {
    expect(resolveHostPreset({ env: { NITRO_PRESET: " ", VITEHUB_HOSTING: "cloudflare" }, hosting: "", nitro: { preset: "" } })).toBe("cloudflare")
    expect(resolveHost({ env: {} })).toBeUndefined()
    expect(resolveHost({ env: {}, nitro: { preset: "static" } })).toBeUndefined()
  })
})
