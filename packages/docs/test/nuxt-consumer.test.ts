import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { Nitro } from "nitropack"

it("sets up the default MCP and discovery resources in a path-mounted Nuxt consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-consumer-"))
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href
  const docs = (await import(moduleUrl)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content/docs/guide"), { recursive: true })
    await writeFile(join(root, "content/docs/guide/index.md"), "---\ntitle: Guide\n---\nHello\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    nuxt = await loadNuxt({
      cwd: root,
      overrides: {
        dev: false,
        app: { baseURL: "/portal/" },
        modules: [[docs, { base: "/docs/", site: { url: "https://docs.example.com" } }]],
      },
      ready: true,
    })
    // Nuxt exposes Nitro here after modules:done and nitro:config have run.
    const nitro = (nuxt as unknown as { _nitro: Nitro })._nitro
    expect(nitro.options.baseURL).toBe("/portal/")
    // An installed package is in node_modules, where Nuxt adds no auto-imports unless a pattern includes it.
    const shell = join(import.meta.dirname, "../dist/runtime/app/app.vue").replaceAll("\\", "/")
    expect(nuxt.options.imports.transform?.include?.some(pattern => pattern.test(shell))).toBe(true)
    expect(nitro.options.experimental.asyncContext).toBe(true)
    expect((await nitro.unimport?.getImports())?.some(entry => entry.name === "useEvent")).toBe(true)
    expect(nitro.options.runtimeConfig.public.docs).toMatchObject({
      appBase: "/portal/", base: "/docs", mcp: { url: "https://docs.example.com/portal/mcp" },
    })
    const discovery = nitro.options.runtimeConfig.agentDiscovery as { links: Array<{ href: string }>, routes: Array<{ path: string, raw: string }> }
    expect(discovery.links.map(link => link.href)).toEqual(expect.arrayContaining([
      "/portal/llms.txt", "/portal/llms-full.txt", "/portal/sitemap.md",
      "/portal/.well-known/mcp/server-card.json", "https://docs.example.com/portal/sitemap.xml",
    ]))
    expect(discovery.routes).toContainEqual({ path: "/docs/guide", raw: "/portal/raw/docs/guide.md" })
    expect(nitro.options.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "/api/_docs/page/**" }),
      expect.objectContaining({ route: "/api/_docs/search.json" }),
      expect.objectContaining({ route: "/mcp" }),
    ]))
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it("ships the MCP tools as JavaScript that Nitro can parse from node_modules", async () => {
  // Nitro compiles TypeScript only outside node_modules, so an installed app parses these files as they are.
  const { parseAst } = createRequire(fileURLToPath(import.meta.resolve("nitropack")))("rollup/parseAst") as { parseAst: (code: string) => unknown }
  const dir = join(import.meta.dirname, "../dist/runtime/mcp")
  const files = (await readdir(dir)).sort()
  expect(files).toEqual(["get-page.js", "list-pages.js"])
  for (const file of files) {
    const source = await readFile(join(dir, file), "utf8")
    expect(() => parseAst(source), file).not.toThrow()
  }
})

// A static host serves the prerendered HTML, and the HTML leaves the page data to `_payload.json`. The client must read
// that file, or every page hydrates to "Page not found".
it("lets the client read the payload of prerendered pages with the default Nuxt config", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-consumer-"))
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href
  const docs = (await import(moduleUrl)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content/docs/guide"), { recursive: true })
    await writeFile(join(root, "content/docs/guide/index.md"), "---\ntitle: Guide\n---\nHello\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    // `_prepare` writes the app templates, as `nuxi prepare` does, and stops before the bundle.
    nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, _prepare: true, modules: [[docs, { mcp: false }]] }, ready: true })
    await build(nuxt)
    expect(nuxt.vfs[join(nuxt.options.buildDir, "nuxt.config.mjs")]).toContain("export const payloadExtraction = true")
    expect((nuxt as unknown as { _nitro: Nitro })._nitro.options.prerender.routes).toEqual(expect.arrayContaining(["/docs/guide", "/api/_docs/page/docs/guide.json"]))
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
