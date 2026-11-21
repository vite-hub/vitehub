import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { expect, it, vi } from "vitest"

// Nitro prerenders with a second Rolldown build that has no Vite plugins. KV must still give it the app's config.
it("prerenders a Nuxt route that uses KV with the configured store", async () => {
  const cache = resolve(import.meta.dirname, "../../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "nuxt-kv-prerender-"))
  const messages: string[] = []
  const record = (...args: unknown[]) => { messages.push(args.map(String).join(" ")) }
  const spies = (["error", "info", "log", "warn"] as const).map(method => vi.spyOn(console, method).mockImplementation(record))
  const streams = [process.stderr, process.stdout].map(stream => vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => { messages.push(String(chunk)); return true }))
  try {
    await mkdir(join(root, "server/routes"), { recursive: true })
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    for (const name of ["@vite-hub/kv", "nuxt", "vite-hub", "vue"]) {
      const target = name === "vite-hub" ? resolve(import.meta.dirname, "..") : resolve(import.meta.dirname, "../node_modules", name)
      await symlink(target, join(root, "node_modules", name), "dir")
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@vite-hub/kv": "*", nuxt: "*", "vite-hub": "*", vue: "*" } }))
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { host: "node", console: false, kv: { driver: "fs-lite", base: ${JSON.stringify(join(root, ".data/prerender-kv"))} } },
  nitro: { prerender: { routes: ["/probe"] } },
})
`)
    await writeFile(join(root, "app.vue"), "<template><div /></template>\n")
    await writeFile(join(root, "server/routes/probe.ts"), `import { kv } from "vite-hub/kv"

export default {
  async fetch() {
    await kv.set("probe", "prerendered")
    const [, value] = await kv.get("probe")
    return new Response(String(value))
  },
}
`)

    const { build, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false } })
    try {
      await build(nuxt)
    }
    finally {
      await nuxt.close()
    }

    await expect(readFile(join(root, ".output/public/probe"), "utf8")).resolves.toBe("prerendered")
    // Without the config, the prerender falls back to the default fs-lite folder.
    expect(existsSync(join(root, ".data/prerender-kv"))).toBe(true)
    const output = messages.join("\n")
    expect(output).not.toContain("#vitehub/kv/config")
    expect(output).not.toContain("Could not read the KV configuration")
  }
  finally {
    for (const spy of [...spies, ...streams]) spy.mockRestore()
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
