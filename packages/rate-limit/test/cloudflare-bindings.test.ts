import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverRateLimitDeclarations } from "../src/discovery.ts"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { createCloudflareRateLimitBindings } from "../src/internal/cloudflare-bindings.ts"
import { writeRateLimitManifest } from "../src/internal/manifest.ts"

import type { RateLimitPolicy } from "../src/index.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function projectWithDeclaration(policy: RateLimitPolicy = { limit: 10, window: "1m" }) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-bindings-"))
  roots.push(root)
  return {
    declarations: [{ name: "upload", policy, source: { column: 1, file: join(root, "src", "upload.ts"), line: 1 } }],
    root,
  }
}

describe("Cloudflare Rate Limit bindings", () => {
  it("emits native Cloudflare bindings with stable policy", async () => {
    const { declarations } = await projectWithDeclaration()
    expect(createCloudflareRateLimitBindings(declarations, "acme-image-service")).toEqual([{
      name: getCloudflareRateLimitBindingName("upload"),
      namespace_id: expect.stringMatching(/^\d+$/),
      simple: { limit: 10, period: 60 },
    }])
  })

  it("emits bindings only for discovered ViteHub guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-discovered-bindings-"))
    roots.push(root)
    const routes = join(root, "server", "api")
    await mkdir(routes, { recursive: true })
    await writeFile(join(routes, "code.post.ts"), 'requireRateLimit(event, "code-image", { limit: 5, window: "1m" })\n')
    await writeFile(join(routes, "files.post.ts"), [
      'import { requireRateLimit as requireUploadLimit } from "vite-hub/rate-limit"',
      'requireUploadLimit(event, "file-upload", { limit: 10, window: "1m" })',
      "",
    ].join("\n"))
    await writeFile(join(routes, "local.post.ts"), [
      "const requireRateLimit = local",
      'requireRateLimit(event, "lookalike", { limit: 1, window: "1m" })',
      "",
    ].join("\n"))

    const declarations = discoverRateLimitDeclarations({ rootDir: root })
    expect(createCloudflareRateLimitBindings(declarations, "drop-production").map(binding => binding.name)).toEqual([
      getCloudflareRateLimitBindingName("code-image"),
      getCloudflareRateLimitBindingName("file-upload"),
    ])
  })

  it("rejects unsupported Cloudflare guarantees", async () => {
    const strict = await projectWithDeclaration({ enforcement: "strict", limit: 10, window: "1m" })
    expect(() => createCloudflareRateLimitBindings(strict.declarations, "test")).toThrow("best-effort")
    const window = await projectWithDeclaration({ limit: 10, window: "5m" })
    expect(() => createCloudflareRateLimitBindings(window.declarations, "test")).toThrow("only 10s and 1m")
  })

  it("writes resolved provider guarantees to the stable manifest", async () => {
    const { declarations, root } = await projectWithDeclaration()
    await writeRateLimitManifest(root, declarations, "cloudflare")

    await expect(readFile(join(root, ".vitehub", "rate-limit", "manifest.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      rateLimits: [{
        capabilities: {
          enforcement: "best-effort",
          rejectedAttempts: "unknown",
          scope: "location",
          windows: [10_000, 60_000],
        },
        name: "upload",
        provider: "cloudflare",
      }],
      schemaVersion: 2,
    })
  })
})
