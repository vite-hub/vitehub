import { describe, expect, it } from "vitest"

import { buildHints, providerEnabled, readOutputFile } from "./helpers.ts"
import { getCloudflareRateLimitBindingName } from "../../packages/rate-limit/src/drivers/cloudflare.ts"

const BUNDLE = "playground/vite/dist/vite/index.js"
const WRANGLER = "playground/vite/dist/vite/wrangler.json"

const bundle = () => readOutputFile(BUNDLE, buildHints.cloudflare)
const wrangler = () => JSON.parse(readOutputFile(WRANGLER, buildHints.cloudflare))

const importsOf = (source: string, specifier: string) =>
  new RegExp(`(from\\s+|require\\(|import\\()\\s*["']${specifier.replaceAll("/", "\\/")}["']`).test(source)

describe.runIf(providerEnabled("cloudflare"))("cloudflare provider output", () => {
  it("bundle excludes Vercel runtime dependencies", () => {
    expect(importsOf(bundle(), "@vercel/functions"), "@vercel/functions leaked into the Cloudflare bundle").toBe(false)
    expect(importsOf(bundle(), "@vercel/blob"), "@vercel/blob leaked into the Cloudflare bundle").toBe(false)
  })

  it("bundle excludes bare @cloudflare/sandbox imports", () => {
    expect(importsOf(bundle(), "@cloudflare/sandbox")).toBe(false)
  })

  it("bundle excludes Vite and DevTools runtime code", () => {
    expect(bundle().includes("@vitejs/devtools")).toBe(false)
    expect(/import\(["']vite["']\)/.test(bundle())).toBe(false)
  })

  it("bundle does not call createRequire(import.meta.url)", () => {
    expect(/createRequire\(\s*import\.meta\.url\s*\)/.test(bundle())).toBe(false)
  })

  it("wrangler.json declares the daily-marker cron trigger", () => {
    expect(wrangler().triggers?.crons).toContain("* * * * *")
  })

  it("wrangler.json declares kv namespaces", () => {
    expect(Array.isArray(wrangler().kv_namespaces)).toBe(true)
    expect(wrangler().kv_namespaces.length).toBeGreaterThan(0)
  })

  it("wrangler.json declares Rate Limit bindings", () => {
    expect(wrangler().ratelimits).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: getCloudflareRateLimitBindingName("e2e-rate-limit-address") }),
      expect.objectContaining({ name: getCloudflareRateLimitBindingName("e2e-rate-limit-key") }),
    ]))
  })

  it("wrangler.json declares D1 databases", () => {
    expect(wrangler().d1_databases).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: "DB" }),
      expect.objectContaining({ binding: "DB_ANALYTICS" }),
    ]))
  })

  it("wrangler.json has no Workspace Artifacts bindings", () => {
    expect(wrangler().artifacts).toBeUndefined()
  })
})
