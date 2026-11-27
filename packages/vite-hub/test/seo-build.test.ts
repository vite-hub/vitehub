import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"
import { linkFixtureModules, startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]!)
}

const cwd = process.cwd()

afterEach(() => {
  process.chdir(cwd)
})

describe("seo.sitemap in a built Nitro 3 app", () => {
  it("serves /sitemap.xml with prerender routes, Content pages, and server/sitemap.ts, and /robots.txt that names it", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "seo-build", private: true, type: "module" }),
      "content/guides/start.md": "---\ntitle: Start\n---\n\n# Start\n",
      "server/content.ts": [
        "import { contentSource, defineContent } from 'vite-hub/content'",
        "import { glob } from 'vite-hub/source'",
        "",
        "export default defineContent({ source: contentSource(glob({ cwd: 'content', include: '**/*.md' }), { url: '/:id' }), seo: { sitemap: true, robots: true } })",
        "",
      ].join("\n"),
      "server/sitemap.ts": [
        "import { defineSitemap } from 'vite-hub/seo'",
        "",
        "export default defineSitemap(async () => [{ loc: '/products/kettle', lastmod: '2026-11-10' }])",
        "",
      ].join("\n"),
      "server/routes/pricing.ts": "export default () => '<h1>Pricing</h1>'\n",
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
    })
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const app = [vitehub({ host: "node", publicUrl: "https://shop.example.com", seo: { sitemap: true } }), nitro()]
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", nitro: { prerender: { routes: ["/pricing"] } }, plugins: app, root } as never)
    await builder.buildApp()

    process.chdir(root)
    const server = await startBuiltServer(root, {})
    try {
      const sitemap = await server.fetch("/sitemap.xml")
      expect(sitemap.status).toBe(200)
      const xml = await sitemap.text()
      expect(locs(xml)).toEqual([
        "https://shop.example.com/guides/start",
        "https://shop.example.com/pricing",
        "https://shop.example.com/products/kettle",
      ])
      expect(xml).toContain("<lastmod>2026-11-10T00:00:00.000Z</lastmod>")
      const robots = await server.fetch("/robots.txt")
      expect(await robots.text()).toBe("User-agent: *\nAllow: /\n\nSitemap: https://shop.example.com/sitemap.xml\n")
    }
    finally {
      server.close()
    }
  }, 180_000)
})

describe("seo.sitemap in a built Nuxt app", () => {
  it("lists the Nuxt pages without a dynamic part and the server/sitemap.ts entries, at the request origin without publicUrl", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vitehub-seo-nuxt-")))
    try {
      await linkFixtureModules(root, { nuxt: dirname(createRequire(import.meta.url).resolve("nuxt/package.json")) })
      const files: Record<string, string> = {
        "package.json": JSON.stringify({ private: true, type: "module" }),
        "nuxt.config.ts": [
          `import viteHubNuxt from "vite-hub/nuxt"`,
          ``,
          `export default defineNuxtConfig({`,
          `  compatibilityDate: "2026-10-01",`,
          `  devtools: { enabled: false },`,
          `  modules: [[viteHubNuxt, { host: "node", seo: { sitemap: { exclude: ["/admin"] }, robots: { disallow: ["/api/"] } } }]],`,
          `  telemetry: false,`,
          `})`,
          ``,
        ].join("\n"),
        "app/app.vue": "<template><NuxtPage /></template>\n",
        "app/pages/index.vue": "<template><h1>Shop</h1></template>\n",
        "app/pages/about.vue": "<template><h1>About</h1></template>\n",
        "app/pages/admin.vue": "<template><h1>Admin</h1></template>\n",
        "app/pages/products/[slug].vue": "<template><h1>Product</h1></template>\n",
        "server/sitemap.ts": "import { defineSitemap } from 'vite-hub/seo'\n\nexport default defineSitemap([{ loc: '/products/kettle' }])\n",
        "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
      }
      for (const [path, source] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), source)
      }
      await promisify(execFile)(process.execPath, [join(root, "node_modules/nuxt/bin/nuxt.mjs"), "build"], { cwd: root, env: { ...process.env, NODE_ENV: "production" } }).catch((error: Error & { stdout?: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}`, { cause: error })
      })
      const server = await startBuiltServer(root, { NODE_ENV: "production" })
      try {
        const origin = `http://127.0.0.1:${server.port}`
        expect(locs(await (await server.fetch("/sitemap.xml")).text())).toEqual([`${origin}/`, `${origin}/about`, `${origin}/products/kettle`])
        expect(await (await server.fetch("/robots.txt")).text()).toBe(`User-agent: *\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`)
      }
      finally {
        server.close()
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 240_000)
})
