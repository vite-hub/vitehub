import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { createCloudflareRateLimitBindings, writeRateLimitProviderOutput } from "../src/internal/provider-output.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function projectWithDefinition(source = `export default defineRateLimit({ limit: 10, window: "1m" })\n`) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-output-"))
  roots.push(root)
  const handler = join(root, "src", "upload.rate-limit.ts")
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(handler, source)
  return { definitions: [{ handler, name: "upload", source: "vite-suffix" as const }], root }
}

describe("Rate Limit Provider Output", () => {
  it("emits native Cloudflare bindings with stable policy", async () => {
    const { definitions, root } = await projectWithDefinition()
    expect(createCloudflareRateLimitBindings(definitions, root)).toEqual([{
      name: getCloudflareRateLimitBindingName("upload"),
      namespace_id: expect.stringMatching(/^\d+$/),
      simple: { limit: 10, period: 60 },
    }])
  })

  it("writes resolved provider guarantees to the stable manifest", async () => {
    const { definitions, root } = await projectWithDefinition()
    await writeRateLimitProviderOutput({ clientOutDir: "dist", definitions, provider: "cloudflare", rootDir: root })

    await expect(readFile(join(root, ".vitehub", "rate-limit", "manifest.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      definitions: [{
        capabilities: {
          enforcement: "best-effort",
          metadata: {
            remaining: { availability: "never" },
            resetAt: { availability: "never" },
            retryAfter: { availability: "never" },
            used: { availability: "never" },
          },
          rejectedAttempts: "unknown",
          scope: "location",
          windows: [10_000, 60_000],
        },
        name: "upload",
        provider: "cloudflare",
      }],
      schemaVersion: 1,
    })
  })

  it("rejects unsupported Cloudflare guarantees and dynamic policy", async () => {
    const strict = await projectWithDefinition(`export default defineRateLimit({ enforcement: "strict", limit: 10, window: "1m" })\n`)
    expect(() => createCloudflareRateLimitBindings(strict.definitions, strict.root)).toThrow("best-effort")
    const window = await projectWithDefinition(`export default defineRateLimit({ limit: 10, window: "5m" })\n`)
    expect(() => createCloudflareRateLimitBindings(window.definitions, window.root)).toThrow("only 10s and 1m")
    const dynamic = await projectWithDefinition(`const limit = 10\nexport default defineRateLimit({ limit, window: "1m" })\n`)
    expect(() => createCloudflareRateLimitBindings(dynamic.definitions, dynamic.root)).toThrow("static limit and window")
    const unrelatedLiteral = await projectWithDefinition(`const defaults = { limit: 10 }\nexport default defineRateLimit({ limit: defaults.limit, window: "1m" })\n`)
    expect(() => createCloudflareRateLimitBindings(unrelatedLiteral.definitions, unrelatedLiteral.root)).toThrow("static limit and window")
    const spread = await projectWithDefinition(`const overrides = { limit: 20 }\nexport default defineRateLimit({ limit: 10, window: "1m", ...overrides })\n`)
    expect(() => createCloudflareRateLimitBindings(spread.definitions, spread.root)).toThrow("cannot use object spreads")
  })

  it("owns only ViteHub Rate Limit entries and cleans stale bindings", async () => {
    const { definitions, root } = await projectWithDefinition()
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    const configFile = join(outputRoot, "wrangler.json")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(configFile, `${JSON.stringify({
      ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`)

    await writeRateLimitProviderOutput({ clientOutDir: "dist", definitions, provider: "cloudflare", rootDir: root })
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
      ratelimits: [
        { name: "MANUAL" },
        { name: getCloudflareRateLimitBindingName("upload") },
      ],
      triggers: { crons: ["0 0 * * *"] },
    })

    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      definitions: [],
      previousDefinitions: definitions,
      provider: "memory",
      rootDir: root,
    })
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({
      ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }],
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("persists ownership across build processes for renamed Definitions", async () => {
    const { definitions, root } = await projectWithDefinition()
    await writeRateLimitProviderOutput({ clientOutDir: "dist", definitions, provider: "cloudflare", rootDir: root })

    const renamedHandler = join(root, "src", "renamed.rate-limit.ts")
    await writeFile(renamedHandler, 'export default defineRateLimit({ limit: 20, window: "10s" })\n')
    const renamed = [{ handler: renamedHandler, name: "renamed", source: "vite-suffix" as const }]
    await writeRateLimitProviderOutput({ clientOutDir: "dist", definitions: renamed, provider: "cloudflare", rootDir: root })

    const configFile = join(createDefaultCloudflareOutputRoot(root), "wrangler.json")
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
      ratelimits: [{ name: getCloudflareRateLimitBindingName("renamed"), simple: { limit: 20, period: 10 } }],
    })
  })
})
