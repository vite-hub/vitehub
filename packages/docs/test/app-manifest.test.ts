import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { createDocsManifest, docsAppManifest, docsAppManifestSource, docsAppPanelSource } from "../src/manifest.ts"
import { docsHomePath, docsManifestPages, docsPanelSidebarGroups, docsSectionPanels, docsStartPage, findDocsPage, loadDocsPanels } from "../src/navigation.ts"

import type { DocsPanelLoaders } from "../src/navigation.ts"
import type { DocsAppPage, DocsManifest } from "../src/types.ts"

async function appManifest(files: Record<string, string>, panels = false): Promise<{ full: DocsManifest, app: DocsManifest<DocsAppPage>, loaders: DocsPanelLoaders }> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vitehub-docs-app-manifest-"))
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), contents)
    }
    const full = await createDocsManifest({ dir, base: "/docs" })
    const split = docsAppManifest(full, { panels })
    writeFileSync(join(dir, "app-manifest.mjs"), docsAppManifestSource(split.manifest))
    split.panels.forEach((panel, index) => writeFileSync(join(dir, `panel-${index}.mjs`), docsAppPanelSource(panel)))
    // SAFETY: the module default-exports the app manifest that docsAppManifestSource() writes.
    const app = (await import(join(dir, "app-manifest.mjs")) as { default: DocsManifest<DocsAppPage> }).default
    const pages = await Promise.all(split.panels.map(async (_, index) => await import(join(dir, `panel-${index}.mjs`)) as { default: DocsAppPage[] }))
    const loaders: DocsPanelLoaders = Object.fromEntries(split.panels.map((panel, index) => [panel.path, async () => pages[index]!]))
    return { full, app, loaders }
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

describe("docsAppManifestSource", () => {
  it("opens the start page past a home landing using the app manifest", async () => {
    const { app } = await appManifest({
      "docs/index.md": "---\ntitle: Docs\nlayout: home\n---\n",
      "docs/start/index.md": "---\ntitle: Start\n---\n",
      "introduction.md": "---\ntitle: Introduction\n---\n",
    })
    const start = { section: "start", links: [{ to: "/introduction" }] }
    expect(docsStartPage(app, start)).toBe("/introduction")
    expect(docsHomePath(app, start)).toBe("/introduction")
  })

  it("keeps the fields the app reads and leaves out the ones the page route returns", async () => {
    const { full, app } = await appManifest({
      "docs/index.md": "---\ntitle: Docs\ndescription: Every page.\n---\n",
      "docs/kv/index.md": "---\ntitle: KV\ndescription: Store values.\ntagline: Values on every host.\neyebrow: Data\ncredits: Built on unstorage\nkeywords: [cache]\nseo:\n  title: KV storage\n---\n",
      "docs/kv/usage.md": "---\ntitle: Use KV\nnavigation:\n  title: Usage\n  group: Guides\n---\n",
    })
    const page = app.sections[0]!.pages.find(candidate => candidate.id === "index")!
    expect(page).toEqual({
      id: "index",
      path: "/docs/kv",
      title: "KV",
      sourceTitle: "KV",
      description: "Store values.",
      icon: null,
      layout: full.sections[0]!.pages.find(candidate => candidate.id === "index")!.layout,
      sidebar: true,
      toc: true,
      kind: null,
      group: null,
      navigation: true,
      order: page.order,
    })
    expect(app.sections[0]!.pages.find(candidate => candidate.id === "usage")).toMatchObject({ title: "Usage", sourceTitle: "Use KV", group: "Guides" })
    expect(app.root).toMatchObject({ path: "/docs", sourceTitle: "Docs", description: "Every page." })
    expect(docsManifestPages(app).map(entry => entry.path)).toEqual(docsManifestPages(full).map(entry => entry.path))
    expect(app.sections.map(section => ({ ...section, pages: [] }))).toEqual(full.sections.map(section => ({ ...section, pages: [] })))
  })
  it("loads the pages of a panel when a reader opens it", async () => {
    const { full, app, loaders } = await appManifest({
      "docs/kv/index.md": "---\ntitle: KV\n---\n",
      "docs/kv/usage.md": "---\ntitle: Usage\n---\n",
      "docs/kv/diagnostics/index.md": "---\ntitle: KV diagnostics\nnavigation.title: Diagnostics\nnavigation.panel: true\n---\n",
      "docs/kv/diagnostics/kv_invalid_ttl.md": "---\ntitle: KV_INVALID_TTL\nnavigation.group: Runtime errors\n---\n",
      "docs/kv/diagnostics/kv_invalid_limit.md": "---\ntitle: KV_INVALID_LIMIT\nnavigation.group: Runtime errors\n---\n",
      "docs/kv/diagnostics/kv_hidden.md": "---\ntitle: KV_HIDDEN\nnavigation: false\n---\n",
    }, true)
    const section = app.sections[0]!
    const fullSection = full.sections[0]!
    // Every page loads the section's own pages and the panel's Overview, which knows how many pages it lists.
    expect(section.pages.map(page => page.id).sort()).toEqual(["diagnostics", "index", "usage"])
    expect(docsSectionPanels(section)).toEqual(docsSectionPanels(fullSection).map(entry => ({ ...entry, page: expect.objectContaining({ path: entry.page.path, panelSize: 2 }) })))
    expect(findDocsPage(app, "/docs/kv/diagnostics/kv_invalid_ttl")).toBeNull()

    await loadDocsPanels(app, "/docs/kv/usage", loaders)
    expect(section.pages).toHaveLength(3)
    await loadDocsPanels(app, "/docs/kv/diagnostics/kv_invalid_ttl/", loaders)
    await loadDocsPanels(app, "/docs/kv/diagnostics", loaders)
    expect(docsManifestPages(app).map(page => page.path).sort()).toEqual(docsManifestPages(full).map(page => page.path).sort())
    expect(findDocsPage(app, "/docs/kv/diagnostics/kv_invalid_ttl")).toMatchObject({ page: { sourceTitle: "KV_INVALID_TTL" }, section: { id: "kv" } })
    const panel = section.pages.find(page => page.panel)!
    const titles = (groups: ReturnType<typeof docsPanelSidebarGroups>) => groups.map(group => ({ label: group.label, pages: group.pages.map(page => page.title) }))
    expect(titles(docsPanelSidebarGroups(section, panel))).toEqual(titles(docsPanelSidebarGroups(fullSection, fullSection.pages.find(page => page.panel)!)))
  })

  it("keeps every page in development and in a section with a panel inside a panel", async () => {
    const files = {
      "docs/kv/index.md": "---\ntitle: KV\n---\n",
      "docs/kv/diagnostics/index.md": "---\ntitle: Diagnostics\nnavigation.panel: true\n---\n",
      "docs/kv/diagnostics/kv_invalid_ttl.md": "---\ntitle: KV_INVALID_TTL\n---\n",
    }
    expect(docsManifestPages((await appManifest(files, false)).app)).toHaveLength(3)
    const nested = await appManifest({ ...files, "docs/kv/diagnostics/cli/index.md": "---\ntitle: CLI\nnavigation.panel: true\n---\n", "docs/kv/diagnostics/cli/kv_cli.md": "---\ntitle: KV_CLI\n---\n" }, true)
    expect(docsManifestPages(nested.app)).toHaveLength(5)
    expect(nested.loaders).toEqual({})
  })
})
