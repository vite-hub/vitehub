import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { createDocsManifest, DocsContentError } from "../src/manifest.ts"
import { docsManifestPages, findDocsPage } from "../src/navigation.ts"

import type { DocsManifest } from "../src/types.ts"

function withContent(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vitehub-docs-manifest-"))
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), contents)
    }
    run(dir)
  }
  finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

function manifestOf(files: Record<string, string>, base = "/docs"): DocsManifest {
  let manifest: DocsManifest | undefined
  withContent(files, (dir) => {
    manifest = createDocsManifest({ dir, base })
  })
  return manifest!
}

describe("createDocsManifest", () => {
  it.each([
    ["docs/start/guide.md", "docs/start/guide/index.md"],
    ["docs/start.md", "docs/start/index.md"],
    ["about.md", "about/index.md"],
  ])("rejects duplicate routes from %s and %s", (first, second) => {
    expect(() => manifestOf({ [first]: "---\ntitle: First\n---\n# First", [second]: "---\ntitle: Second\n---\n# Second" })).toThrow(DocsContentError)
    expect(() => manifestOf({ [first]: "---\ntitle: First\n---\n# First", [second]: "---\ntitle: Second\n---\n# Second" })).toThrow(new RegExp(`${first}.*${second}|${second}.*${first}`))
  })

  it("reads sections, ordered pages, and pages outside the base", () => {
    const manifest = manifestOf({
      "docs/index.md": "---\ntitle: ViteHub docs\nnavigation.order: 0\n---\n\nStart here.\n",
      "docs/server-primitives/index.md": "---\ntitle: Overview\nnavigation.order: 1\n---\n\nServer content.\n",
      "docs/server-primitives/.navigation.yml": "title: Server primitives\nicon: i-lucide-server-cog\norder: 30\ncategory: Data\ngroup: Platform\n",
      "docs/server-primitives/kv.md": "---\ntitle: KV\nnavigation.order: 2\nnavigation.group: Storage\n---\n\nKV content.\n",
      "docs/server-primitives/middle.md": "---\ntitle: Middle\nnavigation.order: 1.5\n---\n\nOrdered between the overview and KV.\n",
      "docs/server-primitives/hidden.md": "---\ntitle: Hidden\nnavigation: false\n---\n\nHidden content.\n",
      "contact.md": "---\ntitle: Contact ViteHub\n---\n",
      "about.md": "---\ntitle: About ViteHub\n---\n",
    })

    expect(manifest.base).toBe("/docs")
    expect(manifest.root).toMatchObject({ id: "index", path: "/docs", file: "docs/index.md", title: "ViteHub docs" })
    expect(manifest.sections.map(section => section.id)).toEqual(["server-primitives"])
    expect(manifest.sections[0]).toMatchObject({
      path: "/docs/server-primitives",
      title: "Server primitives",
      icon: "i-lucide-server-cog",
      category: "Data",
      group: "Platform",
      order: 30,
    })
    // The overview comes first. A page without an order sorts after the ordered ones.
    expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual([
      "/docs/server-primitives",
      "/docs/server-primitives/middle",
      "/docs/server-primitives/kv",
      "/docs/server-primitives/hidden",
    ])
    expect(manifest.sections[0]?.pages.find(page => page.id === "kv")?.group).toBe("Storage")
    expect(manifest.sections[0]?.pages.find(page => page.id === "hidden")?.navigation).toBe(false)
    expect(manifest.pages.map(page => [page.path, page.file])).toEqual([
      ["/about", "about.md"],
      ["/contact", "contact.md"],
    ])
  })

  it("joins section and page paths without a double slash when the base is the site root", () => {
    const manifest = manifestOf({
      "index.md": "---\ntitle: Home\n---\n",
      "guide/index.md": "---\ntitle: Guide\n---\n",
      "guide/install.md": "---\ntitle: Install\n---\n",
    }, "/")

    expect(manifest.root?.path).toBe("/")
    expect(manifest.sections.map(section => section.path)).toEqual(["/guide"])
    expect(manifest.sections[0]?.pages.map(page => page.path)).toEqual(["/guide", "/guide/install"])
  })

  it.each(["/", "/docs"])("retains direct Markdown pages under the base %s exactly once", (base) => {
    const prefix = base === "/" ? "" : "docs/"
    const manifest = manifestOf({
      [`${prefix}index.md`]: "---\ntitle: Home\n---\n",
      [`${prefix}faq.md`]: "---\ntitle: FAQ\n---\n",
      [`${prefix}guide/index.md`]: "---\ntitle: Guide\n---\n",
    }, base)
    const path = base === "/" ? "/faq" : "/docs/faq"

    expect(manifest.pages.map(page => page.path)).toEqual([path])
    expect(findDocsPage(manifest, path)?.page.file).toBe(`${prefix}faq.md`)
    expect(docsManifestPages(manifest).map(page => page.path)).toEqual([base, `${base === "/" ? "" : base}/guide`, path])
  })

  it("stops on frontmatter that does not match the schema", () => {
    withContent({ "docs/kv/index.md": "---\ntitle: KV\nlayout: wide\n---\n" }, (dir) => {
      expect(() => createDocsManifest({ dir, base: "/docs" })).toThrow(DocsContentError)
    })
  })

  it.each([
    ["layuot: landing", "layuot"],
    ["navigation:\n  titel: Guide", "titel"],
    ["seo.descriptionn: Description", "descriptionn"],
  ])("rejects unknown page fields: %s", (fields, key) => {
    withContent({ "docs/guide/index.md": `---\ntitle: Guide\n${fields}\n---\n` }, (dir) => {
      expect(() => createDocsManifest({ dir, base: "/docs" })).toThrow(DocsContentError)
      expect(() => createDocsManifest({ dir, base: "/docs" })).toThrow(key)
    })
  })

  it("rejects unknown section fields", () => {
    withContent({
      "docs/guide/index.md": "---\ntitle: Guide\n---\n",
      "docs/guide/.navigation.yml": "titel: Guide\n",
    }, (dir) => {
      expect(() => createDocsManifest({ dir, base: "/docs" })).toThrow(DocsContentError)
      expect(() => createDocsManifest({ dir, base: "/docs" })).toThrow(/\.navigation\.yml.*titel/)
    })
  })

  it("hides a page with navigation: false even when dotted keys set navigation fields", () => {
    const manifest = manifestOf({
      "docs/kv/index.md": "---\ntitle: KV\n---\n",
      "docs/kv/hidden.md": "---\ntitle: Hidden\nnavigation: false\nnavigation.title: Shown\n---\n",
    })

    expect(manifest.sections[0]?.pages.find(page => page.id === "hidden")).toMatchObject({ navigation: false, title: "Hidden" })
  })
})
