import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { writeTypes } from "nuxt/kit"
import { expect, it } from "vitest"

import type { Nitro } from "nitro/types"

it.each([false, true])("sets up a path-mounted Nuxt consumer (Nuxt UI first: %s)", async (uiFirst) => {
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
        ...uiFirst ? { fonts: { throwOnError: true } } : {},
        modules: [...uiFirst ? [fileURLToPath(import.meta.resolve("@nuxt/ui"))] : [], [docs, { base: "/docs/", site: { url: "https://docs.example.com" } }]],
      },
      ready: true,
    })
    // Nuxt exposes Nitro here after modules:done and nitro:config have run.
    const nitro = (nuxt as unknown as { _nitro: Nitro })._nitro
    expect(nitro.options.baseURL).toBe("/portal/")
    // An installed package is in node_modules, where Nuxt adds no auto-imports unless a pattern includes it.
    const shell = join(import.meta.dirname, "../dist/runtime/app/app.vue").replaceAll("\\", "/")
    expect(nuxt.options.imports.transform?.include?.some(pattern => pattern.test(shell))).toBe(true)
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
    // The site lists no @vite-hub/ui, and still gets the design system: its tokens, its focus rule, and Geist.
    const styles = nuxt.options.build.templates.find(template => template.filename === "docs/docs.css")
    const theme = /@import "([^"]+\/theme\.css)"/.exec(String(await styles?.getContents?.({} as never)))?.[1]
    expect(theme && await readFile(theme, "utf8")).toContain(":focus-visible {\n  outline: 2px solid var(--vh-focus);")
    expect(nuxt.options).toMatchObject({
      fonts: {
        throwOnError: uiFirst,
        families: expect.arrayContaining([{ name: "Geist", global: true }, { name: "Geist Mono", global: true }]),
      },
    })
    // @nuxt/fonts 0.14, the version that Nuxt UI asks for, writes empty font files on a Nitro 3 build.
    const fontModules = nuxt.options._installedModules.filter(({ meta }) => meta.name === "@nuxt/fonts")
    expect(fontModules.map(({ meta }) => meta.version)).toEqual([expect.stringMatching(/^1\./)])
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

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

// A site's vue-tsc reads the generated tsconfig, and `nuxi build` and `nuxi dev` write it before the templates exist.
// A `#docs/*` path to a template's `.mjs` types the module from its JavaScript. The app config must also type
// `icon.customize`, which the docs icon plugin sets.
it("gives a site's typecheck the declarations of each #docs template and of icon.customize", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-consumer-"))
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href
  const docs = (await import(moduleUrl)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content/docs/guide"), { recursive: true })
    await writeFile(join(root, "content/docs/guide/index.md"), "---\ntitle: Guide\n---\nHello\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, _prepare: true, modules: [[docs, { mcp: false }]] }, ready: true })
    await writeTypes(nuxt)
    for (const file of ["tsconfig.app.json", "tsconfig.shared.json", "tsconfig.server.json"]) {
      const { compilerOptions } = JSON.parse(await readFile(join(nuxt.options.buildDir, file), "utf8")) as { compilerOptions: { paths: Record<string, string[]> } }
      expect(compilerOptions.paths["#docs/shell"], file).toEqual(["./docs/shell.d.mts"])
    }
    const types = nuxt.options.build.templates.find(template => template.filename === "types/vite-hub-docs.d.ts")
    expect(String(await types?.getContents?.({} as never))).toMatch(/interface CustomAppConfig \{[^}]*customize\?:/)
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
