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

async function buildWrangler(nitroOptions: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-compatibility-date-"))
  try {
    await mkdir(join(root, "server", "routes"), { recursive: true })
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
    for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents)
    const { nitro } = await import("nitro/vite" as string) as { nitro: (options: Record<string, unknown>) => unknown }
    const builder = await createBuilder({
      logLevel: "silent",
      root,
      plugins: [vitehub({ host: "cloudflare", env: false }), nitro(nitroOptions) as never],
    } as Parameters<typeof createBuilder>[0])
    await builder.buildApp()
    return JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8")) as { compatibility_date: string, compatibility_flags: string[] }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it("writes ViteHub's Workers compatibility date, not the build day", async () => {
  const wrangler = await buildWrangler()
  expect(wrangler.compatibility_date).toBe(defaultCloudflareCompatibilityDate)
  expect(wrangler.compatibility_flags).toContain("nodejs_compat")
}, 120_000)

it("keeps the date that the app gives Nitro", async () => {
  expect((await buildWrangler({ compatibilityDate: "2025-09-01" })).compatibility_date).toBe("2025-09-01")
  vi.stubEnv("COMPATIBILITY_DATE", "2025-10-01")
  expect((await buildWrangler()).compatibility_date).toBe("2025-10-01")
}, 240_000)

it.each(["NITRO_COMPATIBILITY_DATE", "SERVER_COMPATIBILITY_DATE", "COMPATIBILITY_DATE", "COMPATIBILITY_DATE_CLOUDFLARE"])("honors %s loaded from the app's .env", async (name) => {
  vi.stubEnv(name, undefined)
  const wrangler = await buildWrangler({}, { ".env": `${name}=2025-10-01\n` })
  expect(wrangler.compatibility_date).toBe("2025-10-01")
}, 120_000)

it("honors the nested Nitro date and Node.js compatibility opt-out in a Nuxt build", async () => {
  const cache = resolve(import.meta.dirname, "../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "cloudflare-compatibility-date-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "app.vue"), "<template><div /></template>\n")
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({
      modules: ["vite-hub/nuxt"],
      vitehub: { host: "cloudflare", env: false },
      nitro: { compatibilityDate: "2025-12-01", cloudflare: { wrangler: { compatibility_flags: ["no_nodejs_compat"] } } },
    })\n`)
    const { build, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "silent" } })
    try {
      await build(nuxt)
    }
    finally {
      await nuxt.close()
    }
    const wrangler = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
    expect(wrangler).toHaveProperty("compatibility_date", "2025-12-01")
    expect(wrangler.compatibility_flags).toContain("no_nodejs_compat")
    expect(wrangler.compatibility_flags).not.toContain("nodejs_compat")
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)

it.each(["inline", "project"])("keeps the Node.js compatibility opt-out in the %s Wrangler config", async (source) => {
  const wranglerConfig = { compatibility_flags: ["no_nodejs_compat"] }
  const wrangler = source === "inline"
    ? await buildWrangler({ cloudflare: { wrangler: wranglerConfig } })
    : await buildWrangler({}, { "wrangler.json": JSON.stringify(wranglerConfig) })
  expect(wrangler.compatibility_date).toBe(defaultCloudflareCompatibilityDate)
  expect(wrangler.compatibility_flags).toContain("no_nodejs_compat")
  expect(wrangler.compatibility_flags).not.toContain("nodejs_compat")
}, 120_000)
