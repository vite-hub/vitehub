import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterEach, expect, it, vi } from "vitest"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { vitehub } from "../src/index.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

async function buildCompatibilityDate(nitroOptions: Record<string, unknown> = {}): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-compatibility-date-"))
  try {
    await mkdir(join(root, "server", "routes"), { recursive: true })
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
    const { nitro } = await import("nitro/vite" as string) as { nitro: (options: Record<string, unknown>) => unknown }
    const builder = await createBuilder({
      logLevel: "silent",
      root,
      plugins: [vitehub({ host: "cloudflare", env: false }), nitro(nitroOptions) as never],
    } as Parameters<typeof createBuilder>[0])
    await builder.buildApp()
    const wrangler = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8")) as { compatibility_date?: unknown }
    return wrangler.compatibility_date
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it("writes ViteHub's Workers compatibility date, not the build day", async () => {
  expect(await buildCompatibilityDate()).toBe(defaultCloudflareCompatibilityDate)
}, 120_000)

it("keeps the date that the app gives Nitro", async () => {
  expect(await buildCompatibilityDate({ compatibilityDate: "2025-09-01" })).toBe("2025-09-01")
  vi.stubEnv("COMPATIBILITY_DATE", "2025-10-01")
  expect(await buildCompatibilityDate()).toBe("2025-10-01")
}, 240_000)
