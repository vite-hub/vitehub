import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { Miniflare } from "miniflare"
import { expect, it } from "vitest"

const route = `
import { defineEventHandler } from "nuxt/server"
import { analyzeShellCommand } from "vite-hub/shell"

export default defineEventHandler(async () => await analyzeShellCommand("cat README.md | rg x", { timeoutMs: 10_000 }))
`

// Nuxt runs its Nitro build separately from Vite, so the sh-syntax resolver must reach it through the replayed plugins.
it("parses shell commands with sh-syntax in a Nuxt Cloudflare Worker", async () => {
  // Inside the package, so Nuxt and Nitro resolve the workspace dependencies without a linked node_modules.
  const root = resolve(import.meta.dirname, "../.cache/shell-nuxt-cloudflare")
  await rm(root, { force: true, recursive: true })
  try {
    await mkdir(join(root, "server/api"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], vitehub: { host: "cloudflare" } })\n`)
    await writeFile(join(root, "app.vue"), "<template><div /></template>\n")
    await writeFile(join(root, "server/api/shell.get.ts"), route)

    const { build, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "silent" } })
    try {
      await build(nuxt)
    }
    finally {
      await nuxt.close()
    }

    const server = join(root, ".output/server")
    const wrangler = JSON.parse(await readFile(join(server, "wrangler.json"), "utf8")) as { compatibility_flags?: string[], main?: string }
    const files = await readdir(server, { recursive: true })
    const entry = wrangler.main ?? "index.mjs"
    const worker = new Miniflare({
      // The build writes today's date. The pinned workerd binary can be older.
      compatibilityDate: "2026-04-20",
      compatibilityFlags: [...new Set([...wrangler.compatibility_flags ?? [], "nodejs_compat"])],
      // Wrangler uploads the emitted WASM file as a compiled module, so the Worker imports it without compiling bytes.
      modules: [
        ...[entry, ...files.filter(file => file.endsWith(".mjs") && file !== entry)].map(file => ({ path: join(server, file), type: "ESModule" as const })),
        ...files.filter(file => file.endsWith(".wasm")).map(file => ({ path: join(server, file), type: "CompiledWasm" as const })),
      ],
      modulesRoot: server,
    })
    try {
      const response = await worker.dispatchFetch("http://localhost/api/shell")
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toMatchObject({ commands: ["cat", "rg"], hasPipelines: true, ok: true })
    }
    finally {
      await worker.dispose()
    }
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
