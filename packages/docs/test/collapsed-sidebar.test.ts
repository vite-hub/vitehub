import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"

const files: Record<string, string> = {
  "content/index.md": "---\ntitle: Lumen\nlayout: home\n---\nRead [the guide](/guide).\n",
  "content/guide/.navigation.yml": "title: Guide\nicon: i-lucide-book-open\norder: 1\n",
  "content/guide/index.md": "---\ntitle: Guide\n---\nStart here.\n",
  "content/guide/wide.md": "---\ntitle: Wide\nsidebar: collapsed\n---\nA page that needs the width.\n",
  "content/guide/plain.md": "---\ntitle: Plain\nsidebar: false\n---\nNo sidebar.\n",
  // An app page in the docs layout, such as a playground, picks its sidebar in `definePageMeta`.
  "app/pages/play.vue": "<script setup lang=\"ts\">\ndefinePageMeta({ layout: \"docs\", sidebar: \"collapsed\" })\n</script>\n\n<template>\n  <div class=\"play\">Playground</div>\n</template>\n",
}

it("collapses the sidebar to a strip on pages that opt in, from frontmatter or page meta", async () => {
  // Inside the package, so the build resolves Tailwind and Nuxt UI as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-collapsed-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), text)
    }
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [[docs, {
        base: "/",
        mcp: false,
        ogImage: false,
        linkChecker: false,
        site: { name: "Lumen", url: "https://lumen.example.com" },
        start: { section: "guide", links: [{ label: "Start", to: "/guide/plain" }] },
      }]],
      nitro: { prerender: { routes: ["/play"] } },
    }
    nuxt = await loadNuxt({ cwd: root, overrides: Object.assign(config, { _generate: true }), ready: true })
    await build(nuxt)
    const page = (path: string) => readFile(join(root, ".output/public", path, "index.html"), "utf8").catch(() => readFile(join(root, ".output/public", `${path}.html`), "utf8"))
    const strip = (html: string) => html.includes('aria-label="Show navigation"')
    const hide = (html: string) => html.includes('aria-label="Hide navigation"')
    const pages = (html: string) => /<nav[^>]*aria-label="Docs pages"/.test(html)
    // The site header hides on wide screens beside a sidebar that carries its controls, as the attribute marks.
    const headerHidden = (html: string) => /<div[^>]*data-docs-sidebar-head/.test(html)

    // A page with `sidebar: collapsed` starts as the strip, with no page list, and the site header hides beside it.
    const wide = await page("guide/wide")
    expect({ strip: strip(wide), pages: pages(wide), headerHidden: headerHidden(wide) }).toEqual({ strip: true, pages: false, headerHidden: true })
    // The collapsed brand follows the configured docs start page, as the open sidebar does.
    expect(wide.match(/<a[^>]*class="[^"]*vh-docs-strip-brand[^"]*"[^>]*>/)?.[0]).toContain('href="/guide/plain"')
    // An app page sets the same in its page meta.
    const play = await page("play")
    expect({ strip: strip(play), pages: pages(play), headerHidden: headerHidden(play) }).toEqual({ strip: true, pages: false, headerHidden: true })
    // Other pages show the open sidebar, which has no collapse button, or no sidebar.
    const guide = await page("guide")
    expect({ strip: strip(guide), hide: hide(guide), pages: pages(guide) }).toEqual({ strip: false, hide: false, pages: true })
    const plain = await page("guide/plain")
    expect({ strip: strip(plain), pages: pages(plain), headerHidden: headerHidden(plain) }).toEqual({ strip: false, pages: false, headerHidden: false })
  }
  finally {
    await nuxt?.close()
    if (!process.env.KEEP_FIXTURE) await rm(root, { recursive: true, force: true })
  }
}, 300_000)
