import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"
import type { ModuleOptions as SchemaOrgOptions } from "nuxt-schema-org"

const meta = (html: string, property: string) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`).exec(html)?.[1]

it.each([true, false])("gives prerendered pages site meta and Schema.org with image generation enabled: %s", async (images) => {
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
    const config: NuxtConfig & { schemaOrg: Partial<SchemaOrgOptions> } = {
      dev: false,
      devtools: { enabled: false },
      modules: [[docs, { mcp: false, ...images ? {} : { ogImage: false }, site: { name: "Lumen", url: "https://lumen.example.com", description: "Lumen docs" } }]],
      schemaOrg: { defaults: false },
      app: { head: { meta: [
        { property: "og:image", content: "https://lumen.example.com/own.png" },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:alt", content: "Global image" },
        { name: "twitter:image", content: "https://lumen.example.com/own.png" },
        { name: "twitter:image:alt", content: "Global image" },
      ] } },
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
    if (images) {
      expect(image).toMatch(/^https:\/\/lumen\.example\.com\/_og\/.+\.png$/)
      expect(meta(install, "og:image:height")).toBe("630")
      // Rendered at build time, so the static host serves the file.
      expect(existsSync(join(root, ".output/public", new URL(image!).pathname))).toBe(true)
    }
    else {
      expect(image).toBe("https://lumen.example.com/own.png")
      expect(existsSync(join(root, ".output/public/_og"))).toBe(false)
    }
    expect.soft(install).toContain("\"@type\":\"WebSite\"")
    expect(install).toContain("\"@type\":\"WebPage\"")
    expect(install).toContain("\"@type\":[\"Article\",\"TechArticle\"]")
    expect(install).toContain("\"@type\":\"BreadcrumbList\"")

    // A page without a description shares the site's.
    expect(meta(await page("docs/guide"), "og:description")).toBe("Lumen docs")
    expect(meta(await page("docs/guide/own"), "og:image")).toBe("https://lumen.example.com/own.png")
    const none = await page("docs/guide/none")
    for (const tag of ["og:image", "og:image:type", "og:image:width", "og:image:height", "og:image:alt", "twitter:image", "twitter:image:alt"]) expect.soft(meta(none, tag)).toBeUndefined()
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
