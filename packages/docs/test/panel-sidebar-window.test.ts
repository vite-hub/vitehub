import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"

const code = (index: number) => `LUMEN_R${String(index).padStart(4, "0")}`
const files: Record<string, string> = {
  "docs/lumen/.navigation.yml": "title: Lumen\norder: 1\n",
  "docs/lumen/index.md": "---\ntitle: Lumen\n---\nLumen.\n",
  "docs/lumen/diagnostics/index.md": "---\ntitle: Diagnostics\nnavigation.panel: true\n---\nEvery Lumen code.\n",
  ...Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
    `docs/lumen/diagnostics/${code(index).toLowerCase()}.md`,
    `---\ntitle: ${code(index)}\nnavigation.group: Runtime errors\nnavigation.order: ${index + 1}\n---\nCode ${index}.\n`,
  ])),
  ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `docs/lumen/diagnostics/lumen_b${String(index).padStart(4, "0")}.md`,
    `---\ntitle: LUMEN_B${String(index).padStart(4, "0")}\nnavigation.group: Build errors\n---\nBuild code ${index}.\n`,
  ])),
  // A panel whose pages have no group: its one group does not fold.
  "docs/lumen/events/index.md": "---\ntitle: Events\nnavigation.panel: true\n---\nEvery Lumen event.\n",
  ...Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
    `docs/lumen/events/event-${String(index).padStart(4, "0")}.md`,
    `---\ntitle: Event ${index}\nnavigation.order: ${index + 1}\n---\nEvent ${index}.\n`,
  ])),
}

it("renders the links around the current page of a long panel group, and no links in a folded group", async () => {
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-panel-window-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, "content", file)), { recursive: true })
      await writeFile(join(root, "content", file), text)
    }
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [[docs, { mcp: false, ogImage: false, linkChecker: false, seoAudit: false, site: { name: "Lumen", url: "https://lumen.example.com" } }]],
    }
    nuxt = await loadNuxt({ cwd: root, overrides: Object.assign(config, { _generate: true, nitro: { static: true } }), ready: true })
    await build(nuxt)
    const html = await readFile(join(root, ".output/public/docs/lumen/diagnostics/lumen_r0150.html"), "utf8")
    const nav = /<nav[^>]*aria-label="Diagnostics pages"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ""
    const links = (prefix: string) => [...nav.matchAll(new RegExp(`href="/docs/lumen/diagnostics/${prefix}\\d{4}"`, "g"))].length
    expect(links("lumen_r")).toBe(60)
    expect(nav).toContain('href="/docs/lumen/diagnostics/lumen_r0150"')
    expect(nav).toContain("Show all 300")
    // The Build errors group starts folded, so it renders its heading and count only.
    expect(links("lumen_b")).toBe(0)
    expect(nav).toContain("Build errors")

    const eventsNav = (path: string) => readFile(join(root, `.output/public/docs/lumen/${path}.html`), "utf8")
      .then(html => /<nav[^>]*aria-label="Events pages"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "")
    const eventLinks = (html: string) => [...html.matchAll(/href="\/docs\/lumen\/events\/event-\d{4}"/g)].length
    const onEvent = await eventsNav("events/event-0150")
    expect(eventLinks(onEvent)).toBe(60)
    expect(onEvent).toContain('href="/docs/lumen/events/event-0150"')
    expect(onEvent).toContain("Show all 300")
    const onOverview = await eventsNav("events")
    expect(eventLinks(onOverview)).toBe(60)
    expect(onOverview).toContain('href="/docs/lumen/events/event-0000"')
  }
  finally {
    await nuxt?.close()
    await rm(root, { force: true, recursive: true })
  }
}, 240_000)
