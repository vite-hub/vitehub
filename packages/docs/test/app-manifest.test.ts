import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { createDocsManifest, docsAppManifestSource } from "../src/manifest.ts"
import { docsHomePath, docsManifestPages, docsStartPage } from "../src/navigation.ts"

import type { DocsAppPage, DocsManifest } from "../src/types.ts"

async function appManifest(files: Record<string, string>): Promise<{ full: DocsManifest, app: DocsManifest<DocsAppPage> }> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vitehub-docs-app-manifest-"))
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), contents)
    }
    const full = await createDocsManifest({ dir, base: "/docs" })
    writeFileSync(join(dir, "app-manifest.mjs"), docsAppManifestSource(full))
    // SAFETY: the module default-exports the app manifest that docsAppManifestSource() writes.
    const app = (await import(join(dir, "app-manifest.mjs")) as { default: DocsManifest<DocsAppPage> }).default
    return { full, app }
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
})
