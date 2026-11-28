import { describe, expect, it } from "vitest"

import { resolveCacheStorage } from "../src/cache-storage.ts"
import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"
import { vitehub } from "../src/index.ts"

/** The codes that `vitehub()` setup, its Vite and Nuxt config, and its build can raise. */
const setupCodes = [
  "CACHE_DRIVER_WRONG_HOST",
  "CACHE_KV_DISABLED",
  "CACHE_NAMESPACE_ID_CONFLICT",
  "CACHE_NAMESPACE_ID_MISSING",
  "VITE_HUB_B0004",
  "VITE_HUB_B0005",
  "VITE_HUB_B0009",
  "VITE_HUB_B0011",
  "VITE_HUB_B0012",
  "VITE_HUB_B0013",
  "VITE_HUB_B0015",
  "VITE_HUB_B0016",
  "VITE_HUB_B0018",
  "VITE_HUB_B0019",
  "VITE_HUB_B0020",
  "VITE_HUB_B0021",
  "VITE_HUB_B0022",
  "VITE_HUB_B0023",
  "VITE_HUB_B0024",
  "VITE_HUB_C0003",
  "VITE_HUB_C0004",
  "VITE_HUB_HOST_PROVIDER_CONFLICT",
  "VITE_HUB_INVALID_OPTION",
  "VITE_HUB_MCP_AUTH_MISSING",
  "VITE_HUB_PUBLIC_URL_INVALID",
  "VITE_HUB_R0001",
  "VITE_HUB_R0075",
  "VITE_HUB_R0076",
  "VITE_HUB_R0077",
  "VITE_HUB_R0078",
  "VITE_HUB_R0079",
  "VITE_HUB_R0080",
  "VITE_HUB_R0081",
  "VITE_HUB_R0082",
  "VITE_HUB_R0083",
  "VITE_HUB_R0084",
  "VITE_HUB_R0085",
  "VITE_HUB_R0087",
  "VITE_HUB_R0088",
  "VITE_HUB_R0089",
  "VITE_HUB_R0120",
  "VITE_HUB_R0121",
  "VITE_HUB_R0124",
  "VITE_HUB_R0125",
  "VITE_HUB_R0126",
  "VITE_HUB_R0127",
  "VITE_HUB_R0128",
  "VITE_HUB_R0129",
  "VITE_HUB_R0131",
  "VITE_HUB_R0132",
  "VITE_HUB_R0135",
  "VITE_HUB_R0136",
  "VITE_HUB_R0137",
  "VITE_HUB_R0141",
  "VITE_HUB_R0142",
  "VITE_HUB_R0144",
  "VITE_HUB_UNKNOWN_OPTION",
] as const

describe("vitehub() setup errors", () => {
  it("give each setup code a fix and its own docs page", () => {
    for (const code of setupCodes) {
      const error = viteHubErrorDiagnostics[code]({ binding: "CACHE", detected: "vercel", driver: "fs-lite", existing: "a", form: "feature", host: "cloudflare", key: "k", message: "m", requested: "b", required: "node", suggestion: "", where: "w", value: "\"x\"", variable: "VERCEL" })
      expect(error.fix, code).toMatch(/\S/)
      expect(error.docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
    }
  })

  it("names the option to change when Connections has no Database", () => {
    expect(() => vitehub({ connections: true, database: false, host: "node" })).toThrow(expect.objectContaining({
      code: "VITE_HUB_R0124",
      fix: expect.stringContaining("`connections: false`"),
    }))
  })

  it("names the host when dataDir is set for a host without files", () => {
    expect(() => vitehub({ dataDir: ".data", host: "cloudflare" })).toThrow(expect.objectContaining({
      code: "VITE_HUB_R0120",
      fix: expect.stringContaining("`host: \"node\"`"),
    }))
  })

  it("gives the MCP server without Auth a code of its own", () => {
    expect(() => vitehub({ host: "node", mcp: true })).toThrow(expect.objectContaining({
      code: "VITE_HUB_MCP_AUTH_MISSING",
      fix: expect.stringContaining("`mcp: { auth: false }`"),
    }))
  })

  it("gives each cache failure the fix of that failure", () => {
    expect(() => resolveCacheStorage({ driver: "kv" }, "cloudflare")).toThrow(expect.objectContaining({
      code: "CACHE_KV_DISABLED",
      fix: expect.stringContaining("`kv: true`"),
    }))
    expect(() => resolveCacheStorage({ driver: "fs-lite" }, "cloudflare")).toThrow(expect.objectContaining({
      code: "CACHE_DRIVER_WRONG_HOST",
      message: "`cache.driver: \"fs-lite\"` needs the node host, but the host is cloudflare.",
    }))
    expect(() => resolveCacheStorage(true, "netlify")).toThrow(expect.objectContaining({
      code: "VITE_HUB_C0003",
      fix: expect.stringContaining("`cache: { driver: \"kv\" }`"),
    }))
  })
})
