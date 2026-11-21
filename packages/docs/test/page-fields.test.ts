import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"
import type { DocsSearchSection } from "../src/types.ts"

const files: Record<string, string> = {
  "index.md": "---\ntitle: Lumen\nlayout: home\ncredits: Built on [Comark](https://comark.dev).\n---\n::lumen-hero\n# Smaller images\n::\n\n## What you get\n\n- One binary\n\nRead [Annotate](/docs/annotate).\n",
  "docs/index.md": "---\ntitle: All docs\nlayout: landing\neyebrow: Catalog label\n---\nAll docs.\n",
  "about.md": "---\ntitle: About\neyebrow: About label\n---\nAbout.\n",
  "docs/annotate/index.md": [
    "---",
    "title: Annotate",
    "eyebrow: Annotate label",
    "description: Marks on screenshots.",
    "tagline: Hand-drawn marks, numbered notes, and arrows on screenshots.",
    "keywords: image annotation, PR evidence",
    "credits: 'Marks from <a href=\"https://annotationkit.vercel.app\">AnnotationKit</a> and [Lucide](https://lucide.dev).'",
    "---",
    "Mark a screenshot.",
    "",
  ].join("\n"),
  "docs/annotate/plain.md": "---\ntitle: Plain\ndescription: A page without a tagline.\n---\nPlain.\n",
}

it("shows the eyebrow and tagline, ends the page with its credits, and searches its keywords", async () => {
  // Inside the package, so the build resolves Tailwind and Nuxt UI as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-page-fields-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, "content", file)), { recursive: true })
      await writeFile(join(root, "content", file), text)
    }
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    await mkdir(join(root, "app/components/content"), { recursive: true })
    await writeFile(join(root, "app/components/content/LumenHero.vue"), "<template><section class=\"lumen-hero\"><slot /></section></template>\n")
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [[docs, { mcp: false, ogImage: false, linkChecker: false, site: { name: "Lumen", url: "https://lumen.example.com" } }]],
    }
    nuxt = await loadNuxt({ cwd: root, overrides: Object.assign(config, { _generate: true, nitro: { static: true } }), ready: true })
    await build(nuxt)
    const output = (path: string) => readFile(join(root, ".output/public", path), "utf8")
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()

    for (const [path, label] of [["docs/annotate", "Annotate label"], ["docs", "Catalog label"], ["about", "About label"]]) {
      const html = await output(`${path}.html`)
      expect(text(/<[^>]+data-slot="headline"[^>]*>([\s\S]*?)<\/(?:div|p)>/.exec(html)?.[1] ?? "")).toBe(label)
    }

    const annotate = await output("docs/annotate.html")
    const description = /<[^>]+data-slot="description"[^>]*>([\s\S]*?)<\/(?:div|p)>/.exec(annotate)?.[1] ?? ""
    expect(text(description)).toBe("Hand-drawn marks, numbered notes, and arrows on screenshots.")
    // The description stays the meta description.
    expect(annotate).toMatch(/<meta name="description" content="Marks on screenshots.">/)
    const credits = /<footer class="vh-docs-credits[\s\S]*?<\/footer>/.exec(annotate)?.[0] ?? ""
    expect(text(credits)).toBe("Marks from AnnotationKit and Lucide .")
    expect(credits).toContain('href="https://annotationkit.vercel.app"')
    expect(credits).toContain('href="https://lucide.dev"')

    // A page without a tagline shows its description, and a page without credits has no footer.
    const plain = await output("docs/annotate/plain.html")
    expect(text(/<[^>]+data-slot="description"[^>]*>([\s\S]*?)<\/(?:div|p)>/.exec(plain)?.[1] ?? "")).toBe("A page without a tagline.")
    expect(plain).not.toContain("<footer class=\"vh-docs-credits")

    // A home page draws the app's blocks at full width, the Markdown after them in the docs prose column, then its credits.
    const home = await output("index.html")
    const [hero, prose, heading, footer] = ['<section class="lumen-hero"', '<div class="docs-content vh-docs-home-prose"', "What you get", '<footer class="vh-docs-credits'].map(part => home.indexOf(part))
    expect(hero).toBeGreaterThan(-1)
    expect(prose).toBeGreaterThan(hero)
    expect(home.indexOf("</section>", hero)).toBeLessThan(prose)
    expect(heading).toBeGreaterThan(prose)
    expect(home.indexOf("One binary")).toBeGreaterThan(heading)
    expect(footer).toBeGreaterThan(home.indexOf("One binary"))
    expect(text(/<footer class="vh-docs-credits[\s\S]*?<\/footer>/.exec(home)?.[0] ?? "")).toBe("Built on Comark .")

    const search: DocsSearchSection[] = JSON.parse(await output("api/_docs/search.json"))
    expect(search.find(record => record.id === "/docs/annotate")?.keywords).toEqual(["image annotation", "PR evidence"])
    expect(search.find(record => record.id === "/docs/annotate/plain")?.keywords).toBeUndefined()
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
