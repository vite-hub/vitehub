import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { rateLimitErrorDiagnostics } from "../src/error-diagnostics.ts"
import { hubRateLimit } from "../src/vite.ts"

const fixedCodes = ["RATE_LIMIT_B0001", "RATE_LIMIT_B0002", "RATE_LIMIT_B0003", "RATE_LIMIT_B0004"] as const
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-error-fixes-"))
  roots.push(root)
  return root
}

it("gives each Rate Limit build code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = rateLimitErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/rate-limit/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the namespace option when a Cloudflare build has no Rate Limit namespace", async () => {
  const root = await createRoot()
  await writeFile(join(root, "upload.ts"), [
    "import { requireRateLimit } from \"@vite-hub/rate-limit\"",
    "export async function upload(event) {",
    "  await requireRateLimit(event, \"upload\", { enforcement: \"best-effort\", limit: 10, window: \"1m\" })",
    "}",
    "",
  ].join("\n"))
  const plugin = hubRateLimit()
  // SAFETY: The test calls the plugin's config hook without a Vite plugin context, which the hook does not use.
  const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown

  expect(() => config({ nitro: { preset: "cloudflare-module" }, root }, { command: "build" })).toThrow(expect.objectContaining({
    code: "RATE_LIMIT_B0001",
    fix: expect.stringContaining("`namespace`"),
  }))
})

it("names the provider option when the production host has no Rate Limit driver", async () => {
  const root = await createRoot()
  vi.stubEnv("VITEHUB_HOST", "vercel")
  const plugin = hubRateLimit()
  // SAFETY: The test calls the plugin's configResolved hook with the fields of the resolved config that it reads.
  const configResolved = plugin.configResolved as (config: unknown) => Promise<void>

  await expect(configResolved({ build: { outDir: "dist" }, command: "build", plugins: [], resolve: { alias: [] }, root })).rejects.toMatchObject({
    code: "RATE_LIMIT_B0002",
    fix: expect.stringContaining("`driver: \"kv\"`"),
  })
})
