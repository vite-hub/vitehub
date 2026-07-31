import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { discoverRateLimitDeclarations } from "../src/discovery.ts"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { createCloudflareRateLimitBindings, resolveRateLimitNamespace, writeRateLimitProviderOutput } from "../src/internal/provider-output.ts"

import type { RateLimitPolicy } from "../src/index.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function projectWithDeclaration(policy: RateLimitPolicy = { limit: 10, window: "1m" }) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-output-"))
  roots.push(root)
  return {
    declarations: [{ name: "upload", policy, source: { column: 1, file: join(root, "src", "upload.ts"), line: 1 } }],
    root,
  }
}

describe("Rate Limit Provider Output", () => {
  it("emits native Cloudflare bindings with stable policy", async () => {
    const { declarations } = await projectWithDeclaration()
    expect(createCloudflareRateLimitBindings(declarations, "acme-image-service")).toEqual([{
      name: getCloudflareRateLimitBindingName("upload"),
      namespace_id: expect.stringMatching(/^\d+$/),
      simple: { limit: 10, period: 60 },
    }])
  })

  it("emits bindings only for discovered ViteHub guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-discovered-output-"))
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

  it("requires a project-unique Cloudflare namespace", async () => {
    const { declarations, root } = await projectWithDeclaration()
    await expect(writeRateLimitProviderOutput({ clientOutDir: "dist", declarations, provider: "cloudflare", rootDir: root }))
      .rejects.toThrow("requires rateLimit.namespace")
  })

  it("normalizes an explicitly configured namespace", () => {
    expect(resolveRateLimitNamespace(" acme-image-service ")).toBe("acme-image-service")
    expect(resolveRateLimitNamespace()).toBeUndefined()
  })

  it("writes resolved provider guarantees to the stable manifest", async () => {
    const { declarations, root } = await projectWithDeclaration()
    await writeRateLimitProviderOutput({ clientOutDir: "dist", declarations, namespace: "acme-image-service", provider: "cloudflare", rootDir: root })

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

  it("removes previously standalone bindings without touching Nitro-owned entries", async () => {
    const { declarations, root } = await projectWithDeclaration()
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    const configFile = join(outputRoot, "wrangler.json")
    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      declarations,
      namespace: "acme-image-service",
      provider: "cloudflare",
      rootDir: root,
    })
    const existingConfig = {
      ratelimits: [
        { name: "NITRO", namespace_id: "7", simple: { limit: 2, period: 10 } },
        { name: getCloudflareRateLimitBindingName("upload"), namespace_id: "8", simple: { limit: 10, period: 60 } },
      ],
      vars: { APP: "vitehub" },
    }
    await writeFile(configFile, `${JSON.stringify(existingConfig, null, 2)}\n`)

    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      declarations,
      namespace: "acme-image-service",
      provider: "cloudflare",
      rootDir: root,
    })

    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({
      ratelimits: [existingConfig.ratelimits[0]],
      vars: { APP: "vitehub" },
    })
    await expect(access(join(root, ".vitehub", "rate-limit", "cloudflare-output.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(root, ".vitehub", "rate-limit", "manifest.json"), "utf8")).resolves.toContain('"provider": "cloudflare"')
  })

  it("cleans renamed standalone bindings during Nitro takeover", async () => {
    const { declarations, root } = await projectWithDeclaration()
    const configFile = join(createDefaultCloudflareOutputRoot(root), "wrangler.json")
    await writeRateLimitProviderOutput({ clientOutDir: "dist", declarations, namespace: "acme-image-service", provider: "cloudflare", rootDir: root })
    const stateFile = join(root, ".vitehub", "rate-limit", "cloudflare-output.json")
    const legacyState = JSON.parse(await readFile(stateFile, "utf8")) as { bindings: string[] }
    await writeFile(stateFile, `${JSON.stringify({ bindings: legacyState.bindings }, null, 2)}\n`)
    const standalone = JSON.parse(await readFile(configFile, "utf8"))
    await writeFile(configFile, `${JSON.stringify({ ...standalone, vars: { APP: "vitehub" } }, null, 2)}\n`)
    const renamed = [{ ...declarations[0]!, name: "renamed" }]

    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      declarations: renamed,
      namespace: "acme-image-service",
      provider: "cloudflare",
      rootDir: root,
    })

    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({ vars: { APP: "vitehub" } })
  })

  it("cleans unchanged standalone bindings during Nitro takeover", async () => {
    const { declarations, root } = await projectWithDeclaration()
    const configFile = join(createDefaultCloudflareOutputRoot(root), "wrangler.json")
    await writeRateLimitProviderOutput({ clientOutDir: "dist", declarations, namespace: "acme-image-service", provider: "cloudflare", rootDir: root })

    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      declarations,
      namespace: "acme-image-service",
      provider: "cloudflare",
      rootDir: root,
    })

    await expect(access(configFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("cleans only marker-owned standalone bindings when Nitro transitions to memory", async () => {
    const { declarations, root } = await projectWithDeclaration()
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    const configFile = join(outputRoot, "wrangler.json")
    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      declarations,
      namespace: "acme-image-service",
      provider: "cloudflare",
      rootDir: root,
    })
    await writeFile(configFile, `${JSON.stringify({
      ratelimits: [
        { name: "MANUAL", namespace_id: "7", simple: { limit: 2, period: 10 } },
        ...createCloudflareRateLimitBindings(declarations, "acme-image-service"),
      ],
      vars: { APP: "vitehub" },
    }, null, 2)}\n`)

    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      declarations,
      provider: "memory",
      rootDir: root,
    })

    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({
      ratelimits: [{ name: "MANUAL", namespace_id: "7", simple: { limit: 2, period: 10 } }],
      vars: { APP: "vitehub" },
    })
    await expect(access(join(root, ".vitehub", "rate-limit", "cloudflare-output.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects unsupported Cloudflare guarantees", async () => {
    const strict = await projectWithDeclaration({ enforcement: "strict", limit: 10, window: "1m" })
    expect(() => createCloudflareRateLimitBindings(strict.declarations, "test")).toThrow("best-effort")
    const window = await projectWithDeclaration({ limit: 10, window: "5m" })
    expect(() => createCloudflareRateLimitBindings(window.declarations, "test")).toThrow("only 10s and 1m")
  })

  it("owns only ViteHub Rate Limit entries and cleans stale bindings", async () => {
    const { declarations, root } = await projectWithDeclaration()
    const outputRoot = createDefaultCloudflareOutputRoot(root)
    const configFile = join(outputRoot, "wrangler.json")
    await mkdir(outputRoot, { recursive: true })
    await writeFile(configFile, `${JSON.stringify({
      ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }],
      triggers: { crons: ["0 0 * * *"] },
    }, null, 2)}\n`)

    await writeRateLimitProviderOutput({ clientOutDir: "dist", declarations, namespace: "acme-image-service", provider: "cloudflare", rootDir: root })
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
      ratelimits: [
        { name: "MANUAL" },
        { name: getCloudflareRateLimitBindingName("upload") },
      ],
      triggers: { crons: ["0 0 * * *"] },
    })

    await writeRateLimitProviderOutput({
      clientOutDir: "dist",
      declarations: [],
      previousDeclarations: declarations,
      provider: "memory",
      rootDir: root,
    })
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toEqual({
      ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }],
      triggers: { crons: ["0 0 * * *"] },
    })
  })

  it("persists ownership across build processes for renamed Rate Limits", async () => {
    const { declarations, root } = await projectWithDeclaration()
    await writeRateLimitProviderOutput({ clientOutDir: "dist", declarations, namespace: "acme-image-service", provider: "cloudflare", rootDir: root })

    const renamed = [{ name: "renamed", policy: { limit: 20, window: "10s" as const }, source: { column: 1, file: "renamed.ts", line: 1 } }]
    await writeRateLimitProviderOutput({ clientOutDir: "dist", declarations: renamed, namespace: "acme-image-service", provider: "cloudflare", rootDir: root })

    const configFile = join(createDefaultCloudflareOutputRoot(root), "wrangler.json")
    await expect(readFile(configFile, "utf8").then(JSON.parse)).resolves.toMatchObject({
      ratelimits: [{ name: getCloudflareRateLimitBindingName("renamed"), simple: { limit: 20, period: 10 } }],
    })
  })
})
