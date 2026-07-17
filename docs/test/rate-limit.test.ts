import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "../content/docs")

function read(relativePath: string): string {
  return readFileSync(resolve(docsRoot, relativePath), "utf8")
}

function routeExists(route: string): boolean {
  const relativePath = route.replace(/^\/docs\/?/, "").replace(/\/$/, "")
  return existsSync(resolve(docsRoot, `${relativePath}.md`))
    || existsSync(resolve(docsRoot, relativePath, "index.md"))
}

describe("Rate Limit documentation", () => {
  it("teaches the canonical first success and owner-package escape hatch", () => {
    const primitive = read("server-primitives/rate-limit.md")

    expect(primitive).toContain("vitehub({ rateLimit: true })")
    expect(primitive).toContain("import { defineRateLimit } from 'vite-hub/rate-limit'")
    expect(primitive).toContain("server/api/image-upload.post.ts")
    expect(primitive).toContain("consumeRateLimit('image-upload'")
    expect(primitive).toContain("if (!decision.allowed)")
    expect(primitive).toContain("POST /api/image-upload")
    expect(primitive).toContain("Use `getRateLimit(name)`")
    expect(primitive).toContain("rateLimit({ limiter: 'image-upload' })")
    expect(primitive).toContain("hubRateLimit")
    expect(primitive).toContain("@vite-hub/rate-limit/vite")
  })

  it("keeps guarantees, identity, and backend limitations explicit", () => {
    const primitive = read("server-primitives/rate-limit.md")

    expect(primitive).toMatch(/local memory driver.*Vite development and serve commands/is)
    expect(primitive).toContain("Cloudflare native enforcement is best-effort")
    expect(primitive).toContain("10-second and 60-second windows")
    expect(primitive).toContain("Identity is caller policy")
    expect(primitive).toContain("`rejectedAttempts`")
    expect(primitive).toContain("best-effort location-scoped enforcement")
    expect(primitive).toContain(".vitehub/rate-limit/manifest.json")
    expect(primitive).toContain('"schemaVersion": 1')
    expect(primitive).toContain('"provider": "cloudflare"')
    expect(primitive).toContain('"capabilities": {')
    expect(primitive).toContain('"availability": "never"')
    expect(primitive).toContain("not an application import")
    expect(primitive).toContain("There is no `@vite-hub/rate-limit/kv` adapter")
    expect(primitive).not.toMatch(/from ['"]@vite-hub\/rate-limit\/(?:kv|capability)['"]/)
    expect(primitive).not.toContain("event?: unknown")
  })

  it("documents the Agent Capability as a consumer of the primitive", () => {
    const capability = read("capabilities/rate-limit.md")

    expect(capability).toContain("limiter: 'agent-invocations'")
    expect(capability).toContain("The Capability no longer owns `limit`, `window`, `action`, or `store`")
    expect(capability).toContain("memoryRateLimitDriver()")
    expect(capability).toContain("retry-after` headers only when")
  })

  it("routes generated and Provider Output inspection through the stable manifest", () => {
    const generated = read("development/generated-files.md")
    const providerOutput = read("reference/provider-output.md")

    for (const page of [generated, providerOutput]) {
      expect(page).toContain(".vitehub/rate-limit/manifest.json")
      expect(page).toContain("schemaVersion: 1")
      expect(page).toMatch(/sorted.*definitions|sorted.*Definition/is)
      expect(page).toMatch(/not an application import|do not import/is)
    }
  })

  it("keeps the new task routes resolvable", () => {
    for (const relativePath of ["server-primitives/rate-limit.md", "capabilities/rate-limit.md"]) {
      const routes = [...read(relativePath).matchAll(/\]\((\/docs(?:\/[^)#\s]*)?)(?:#[^)]+)?\)/g)]
        .map(match => match[1]!)

      expect(routes.filter(route => !routeExists(route)), relativePath).toEqual([])
    }
  })
})
