import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { build, loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { NuxtConfig } from "nuxt/schema"

const files: Record<string, string> = {
  "index.md": "---\ntitle: Lumen\n---\nRead [the docs](/docs/start).\n",
  "docs/start/.navigation.yml": "title: Start\nicon: i-lucide-rocket\norder: 1\ncategory: Start\n",
  "docs/start/index.md": "---\ntitle: Start\n---\nStart here.\n",
  // `annotate` joins the group in the option, `charts` and `table` in their `.navigation.yml`.
  "docs/annotate/.navigation.yml": "title: Annotate\nicon: i-lucide-pen-line\norder: 2\ncategory: Review blocks\n",
  "docs/annotate/index.md": "---\ntitle: Annotate\n---\nMarks on screenshots.\n",
  "docs/charts/.navigation.yml": "title: Charts\nicon: i-lucide-chart-line\norder: 3\ncategory: Charts\ngroup: Components\n",
  "docs/charts/index.md": "---\ntitle: Charts\n---\nCharts.\n",
  "docs/charts/notes.md": "---\ntitle: Notes\n---\nNotes on charts.\n",
  "docs/table/.navigation.yml": "title: Table\nicon: i-lucide-table\norder: 4\ncategory: Charts\ngroup: Components\n",
  "docs/table/index.md": "---\ntitle: Table\n---\nTables.\n",
  // The rules fold, as a list of hundreds of rules would bury the sidebar.
  "docs/lint/.navigation.yml": "title: Linter\nicon: i-lucide-stethoscope\norder: 5\ncategory: Linter\nfold: true\n",
  "docs/lint/index.md": "---\ntitle: Linter\n---\nLint.\n",
  "docs/lint/unclosed-block.md": "---\ntitle: unclosed-block\nnavigation.group: Core\n---\nRule.\n",
  "docs/lint/empty-link.md": "---\ntitle: empty-link\nnavigation.group: Core\n---\nRule.\n",
  "docs/lint/missing-src.md": "---\ntitle: missing-src\nnavigation.group: annotate\n---\nRule.\n",
  "docs/lint/missing-alt.md": "---\ntitle: missing-alt\nnavigation.group: annotate\n---\nRule.\n",
  "docs/migrate/.navigation.yml": "title: Migrate\nicon: i-lucide-arrow-right-left\norder: 6\ncategory: Linter\n",
  "docs/migrate/index.md": "---\ntitle: Migrate\n---\nMigrate.\n",
  "docs/reference/.navigation.yml": "title: Reference\norder: 7\ncategory: Reference\n",
  "docs/reference/index.md": "---\ntitle: Reference\n---\nReference.\n",
  "docs/api/.navigation.yml": "title: API\norder: 8\ncategory: Reference\n",
  "docs/api/index.md": "---\ntitle: API\n---\nAPI.\n",
  "docs/glossary/.navigation.yml": "title: Glossary\norder: 9\ncategory: Reference\n",
  "docs/glossary/index.md": "---\ntitle: Glossary\n---\nGlossary.\n",
}

it("shows one rail item per group and lists every section of the group in its sidebar", async () => {
  // Inside the package, so the build resolves Tailwind and Nuxt UI as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-sidebar-"))
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
      modules: [[docs, {
        mcp: false,
        ogImage: false,
        linkChecker: false,
        site: { name: "Lumen", url: "https://lumen.example.com" },
        categories: ["Start", "Review blocks", "Charts", "Linter", "Reference"],
        railExclude: ["Charts", "Reference"],
        start: { section: "start" },
        groups: [
          { title: "Components", icon: "i-lucide-blocks", sections: ["annotate"] },
          { title: "Reference topics", sections: ["reference", "api"] },
        ],
      }]],
    }
    nuxt = await loadNuxt({ cwd: root, overrides: Object.assign(config, { _generate: true }), ready: true })
    await build(nuxt)
    const page = (path: string) => readFile(join(root, ".output/public", `${path}.html`), "utf8")
    const currentRailLabels = (html: string) => {
      const rail = /<nav[^>]*aria-label="Lumen navigation"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ""
      return [...rail.matchAll(/<a [^>]*>/g)]
        .filter(match => match[0].includes('aria-current="true"'))
        .map(match => /aria-label="([^"]+)"/.exec(match[0])?.[1])
    }

    const charts = await page("docs/charts/notes")
    const rail = /<nav[^>]*aria-label="Lumen navigation"[\s\S]*?<\/nav>/.exec(charts)?.[0] ?? ""
    const railLabels = [...rail.matchAll(/<a [^>]*aria-label="([^"]+)"/g)].map(match => match[1])
    // Components stands for annotate, charts, and table. It opens annotate, its first section.
    expect(railLabels).toEqual(["Lumen", "Start", "Components", "Linter", "Migrate"])
    expect(/<a [^>]*href="\/docs\/annotate"[^>]*>/.exec(rail)?.[0]).toContain('aria-current="true"')
    // Excluded members with a visible group mark that group alone, without the start fallback.
    expect.soft(currentRailLabels(charts)).toEqual(["Components"])

    const sidebar = /<nav[^>]*aria-label="Components pages"[\s\S]*?<\/nav>/.exec(charts)?.[0] ?? ""
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    // The sections span two categories, so each category has a heading. A section opens its home page, and its other pages follow.
    expect(text(sidebar)).toBe("Review blocks Annotate Charts Charts Notes Table")
    expect(/<a [^>]*href="\/docs\/charts\/notes"[^>]*>/.exec(sidebar)?.[0]).toContain('aria-current="page"')

    // A section outside every group keeps its own sidebar. Its rule groups fold, and only the current page's group opens.
    const folds = (html: string) => [...html.matchAll(/<details([^>]*)>\s*<summary[^>]*>([\s\S]*?)<\/summary>/g)].map(match => [text(match[2]!), /\sopen(=""|\s|$)/.test(match[1]!)])
    expect(await page("docs/lint")).toMatch(/<nav[^>]*aria-label="Linter pages"/)
    expect(folds(await page("docs/lint"))).toEqual([["Core", false], ["annotate", false]])
    expect(folds(await page("docs/lint/missing-src"))).toEqual([["Core", false], ["annotate", true]])
    // A section without `fold` keeps its groups open.
    expect(folds(charts)).toEqual([])

    // Every member keeps the shared sidebar even when no member can place the group in the rail.
    for (const path of ["docs/reference", "docs/api"]) {
      const html = await page(path)
      const sidebar = /<nav[^>]*aria-label="Reference topics pages"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ""
      expect.soft(text(sidebar)).toBe("Reference API")
      expect(currentRailLabels(html)).toEqual(["Start"])
    }
    // Ungrouped excluded sections keep the existing start-section fallback.
    expect(currentRailLabels(await page("docs/glossary"))).toEqual(["Start"])
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
