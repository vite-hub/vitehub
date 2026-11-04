import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"

const meta = (html: string, property: string) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1]

it("gives every prerendered page a share image, site meta, and Schema.org, and checks its links before the site is live", async () => {
  // Inside the package, so the build resolves Tailwind and Nuxt UI as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-seo-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content/docs/guide"), { recursive: true })
    await mkdir(join(root, "public"))
    await writeFile(join(root, "content/index.md"), "---\ntitle: Lumen\n---\nRead [the guide](/docs/guide) or [its Markdown](/raw/docs/guide.md).\n")
    await writeFile(join(root, "content/docs/guide/index.md"), "---\ntitle: Guide\n---\nHello\n")
    await writeFile(join(root, "content/docs/guide/install.md"), "---\ntitle: Install\ndescription: From zero to a running site.\n---\nInstall\n")
    await writeFile(join(root, "content/docs/guide/own.md"), "---\ntitle: Own\nseo.image: /own.png\n---\nOwn\n")
    await writeFile(join(root, "content/docs/guide/none.md"), "---\ntitle: None\nseo:\n  image: false\n---\nNone\n")
    await writeFile(join(root, "public/own.png"), "")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [[docs, { mcp: false, site: { name: "Lumen", url: "https://lumen.example.com", description: "Lumen docs" } }]],
    }
    nuxt = await loadNuxt({
      cwd: root,
      // `_generate` is what `nuxi generate` sets: prerender every page to static files. NuxtConfig doesn't type it.
      overrides: Object.assign(config, { _generate: true }),
      ready: true,
    })
    // The link checker fails the build on a broken link. `site.url` isn't live, so every link must resolve in the build.
    await build(nuxt)
    const page = (path: string) => readFile(join(root, ".output/public", `${path}.html`), "utf8")

    const install = await page("docs/guide/install")
    expect(meta(install, "og:title")).toBe("Install")
    expect(meta(install, "og:description")).toBe("From zero to a running site.")
    expect(meta(install, "og:site_name")).toBe("Lumen")
    const image = meta(install, "og:image")
    expect(image).toMatch(/^https:\/\/lumen\.example\.com\/_og\/.+\.png$/)
    expect(meta(install, "og:image:height")).toBe("630")
    // Rendered at build time, so the static host serves the file.
    expect(existsSync(join(root, ".output/public", new URL(image!).pathname))).toBe(true)
    expect(install).toContain("\"@type\":[\"Article\",\"TechArticle\"]")
    expect(install).toContain("\"@type\":\"BreadcrumbList\"")

    // A page without a description shares the site's.
    expect(meta(await page("docs/guide"), "og:description")).toBe("Lumen docs")
    expect(meta(await page("docs/guide/own"), "og:image")).toBe("https://lumen.example.com/own.png")
    expect(meta(await page("docs/guide/none"), "og:image")).toBeUndefined()
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
