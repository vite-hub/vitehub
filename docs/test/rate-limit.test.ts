import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "../content/docs")

function read(relativePath: string): string {
  return readFileSync(resolve(docsRoot, relativePath), "utf8")
}

const primitivePages = [
  "rate-limit/index.md",
  "rate-limit/get-started.md",
  "rate-limit/server-api.md",
  "rate-limit/hosts.md",
  "rate-limit/limits-and-errors.md",
]

function readPrimitive(): string {
  return primitivePages.map(read).join("\n")
}

function routeExists(route: string): boolean {
  const relativePath = route.replace(/^\/docs\/?/, "").replace(/\/$/, "")
  return existsSync(resolve(docsRoot, `${relativePath}.md`))
    || existsSync(resolve(docsRoot, relativePath, "index.md"))
}

describe("Rate Limit documentation", () => {
  it("teaches the canonical first success and owner-package escape hatch", () => {
    const primitive = readPrimitive()

    expect(primitive).toContain('vitehub({ preset: "node", rateLimit: true })')
    expect(primitive).toContain("import { requireRateLimit } from 'vite-hub/rate-limit'")
    expect(primitive).toContain("server/api/image-upload.post.ts")
    expect(primitive).toContain("await requireRateLimit(event, 'image-upload'")
    expect(primitive).toContain("throws a standard H3 `HTTPError`")
    expect(primitive).toContain("does not need a dedicated directory, file suffix, or module-scope declaration")
    expect(primitive).toContain("hubRateLimit")
    expect(primitive).toContain("@vite-hub/rate-limit/vite")
  })

  it("keeps guarantees, identity, and backend limitations explicit", () => {
    const primitive = readPrimitive()

    const tutorial = read("rate-limit/get-started.md")
    expect(tutorial).toContain("counts requests in this process's memory")
    expect(tutorial).toContain("Counts reset on restart")
    expect(tutorial).toContain("not shared with other app instances")
    expect(primitive).toContain("Cloudflare native enforcement is best-effort")
    expect(primitive).toContain("10-second and 60-second windows")
    expect(primitive).toContain("explicit user or tenant identities remain application policy")
    expect(primitive).toContain("`rejectedAttempts`")
    expect(primitive).toContain("best-effort")
    expect(primitive).toContain(".vitehub/rate-limit/manifest.json")
    expect(primitive).toContain('"schemaVersion": 2')
    expect(primitive).toContain('"provider": "cloudflare"')
    expect(primitive).toContain('"capabilities": {')
    expect(primitive).toContain('"scope": "location"')
    expect(primitive).toContain('"windows": [10000, 60000]')
    expect(primitive).toContain("Application code keeps using the guard")
    expect(primitive).not.toMatch(/from ['"]@vite-hub\/rate-limit\/(?:kv|capability)['"]/)
    expect(primitive).not.toContain("event?: unknown")
  })

  it("documents the Agent Capability as a consumer of the primitive", () => {
    const capability = read("rate-limit/agent-capability.md")

    expect(capability).toContain("limiter: invocations")
    expect(capability).toContain("The Capability no longer owns `limit`, `window`, `action`, or `store`")
    expect(capability).toContain("memoryRateLimitDriver()")
    expect(capability).toContain("retry-after` headers only when")
  })

  it("routes generated and Provider Output inspection through the stable manifest", () => {
    const generated = read("development/generated-files.md")
    const providerOutput = read("reference/provider-output.md")

    for (const page of [generated, providerOutput]) {
      expect(page).toContain(".vitehub/rate-limit/manifest.json")
      expect(page).toContain("schemaVersion: 2")
      expect(page).toMatch(/sorted.*rateLimits|sorted.*Rate Limit IDs/is)
      expect(page).toMatch(/not an application import|do not import/is)
    }
  })

  it("keeps the new task routes resolvable", () => {
    for (const relativePath of [...primitivePages, "rate-limit/agent-capability.md"]) {
      const routes = [...read(relativePath).matchAll(/\]\((\/docs(?:\/[^)#\s]*)?)(?:#[^)]+)?\)/g)]
        .map(match => match[1]!)

      expect(routes.filter(route => !routeExists(route)), relativePath).toEqual([])
    }
  })
})
