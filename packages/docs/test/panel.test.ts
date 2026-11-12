import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { createDocsManifest } from "../src/manifest.ts"
import {
  docsIndexedPages,
  docsManifestPages,
  docsPanelOf,
  docsPanelPages,
  docsPanelSidebarGroups,
  docsRailTarget,
  docsSectionPanels,
  docsSidebarGroups,
} from "../src/navigation.ts"
import { docsPageResponse } from "../src/page.ts"

import type { DocsDocument } from "../src/markdown.ts"

const files: Record<string, string> = {
  "docs/queue/.navigation.yml": "title: Queue\norder: 1\n",
  // The section's own Overview cannot open a panel.
  "docs/queue/index.md": "---\ntitle: Queue\nnavigation.panel: true\n---\nQueue.\n",
  "docs/queue/configure.md": "---\ntitle: Configure\nnavigation.order: 1\n---\nConfigure.\n",
  "docs/queue/diagnostics/index.md": "---\ntitle: Diagnostics\nnavigation.panel: true\nnavigation.order: 9\n---\nEvery Queue code.\n",
  "docs/queue/diagnostics/queue_disabled.md": "---\ntitle: QUEUE_DISABLED\nnavigation.group: Configuration errors\nseo.index: false\n---\nDisabled.\n",
  "docs/queue/diagnostics/queue_missing_region.md": "---\ntitle: QUEUE_MISSING_REGION\nnavigation.group: Configuration errors\nseo.index: false\n---\nRegion.\n",
  "docs/queue/diagnostics/queue_provider_failed.md": "---\ntitle: QUEUE_PROVIDER_FAILED\nnavigation.group: Runtime errors\n---\nProvider.\n",
  "docs/kv/.navigation.yml": "title: KV\norder: 2\n",
  "docs/kv/index.md": "---\ntitle: KV\n---\nKV.\n",
  "docs/kv/diagnostics/index.md": "---\ntitle: Diagnostics\nnavigation.panel: true\n---\nEvery KV code.\n",
  "docs/kv/diagnostics/kv_invalid_cursor.md": "---\ntitle: KV_INVALID_CURSOR\nseo.index: false\n---\nCursor.\n",
  "docs/blob/.navigation.yml": "title: Blob\norder: 3\n",
  "docs/blob/index.md": "---\ntitle: Blob\n---\nBlob.\n",
}

const dir = mkdtempSync(join(tmpdir(), "vh-docs-panel-"))
for (const [file, source] of Object.entries(files)) {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), source)
}
afterAll(() => rmSync(dir, { force: true, recursive: true }))

const manifest = await createDocsManifest({ dir, base: "/docs" })

function section(id: string) {
  const found = manifest.sections.find(candidate => candidate.id === id)
  if (!found) throw new Error(`Missing fixture section ${id}`)
  return found
}

function page(path: string) {
  const found = docsManifestPages(manifest).find(candidate => candidate.path === path)
  if (!found) throw new Error(`Missing fixture page ${path}`)
  return found
}

describe("docs panels", () => {
  it("opens a panel only on the Overview of a folder below the section", () => {
    expect(page("/docs/queue/diagnostics").panel).toBe(true)
    expect(page("/docs/queue").panel).toBeUndefined()
    expect(page("/docs/queue/diagnostics/queue_disabled").panel).toBeUndefined()
  })

  it("keeps the pages of a panel out of the section sidebar and links to the panel once", () => {
    const queue = section("queue")
    expect(docsSidebarGroups(queue).flatMap(group => group.pages.map(candidate => candidate.path))).toEqual(["/docs/queue", "/docs/queue/configure"])
    expect(docsSectionPanels(queue).map(entry => [entry.page.path, entry.count])).toEqual([["/docs/queue/diagnostics", 3]])
    expect(docsSectionPanels(section("blob"))).toEqual([])
  })

  it("finds the panel of a page, and its Overview belongs to it", () => {
    const queue = section("queue")
    expect(docsPanelOf(queue, page("/docs/queue/diagnostics/queue_disabled"))?.path).toBe("/docs/queue/diagnostics")
    expect(docsPanelOf(queue, page("/docs/queue/diagnostics"))?.path).toBe("/docs/queue/diagnostics")
    expect(docsPanelOf(queue, page("/docs/queue/configure"))).toBeNull()
    expect(docsPanelPages(queue, null).map(candidate => candidate.id)).toEqual(["index", "configure"])
  })

  it("groups the pages of a panel without its Overview, and every labeled group folds", () => {
    const queue = section("queue")
    const groups = docsPanelSidebarGroups(queue, page("/docs/queue/diagnostics"))
    expect(groups.map(group => [group.label, group.fold, group.pages.map(candidate => candidate.title)])).toEqual([
      ["Configuration errors", true, ["QUEUE_DISABLED", "QUEUE_MISSING_REGION"]],
      [null, false, ["QUEUE_PROVIDER_FAILED"]],
    ])
  })

  it("keeps the reader in the same panel when the rail opens another section", () => {
    const diagnostics = page("/docs/queue/diagnostics/queue_disabled")
    const panel = docsPanelOf(section("queue"), diagnostics)
    expect(docsRailTarget(section("kv"), panel)).toBe("/docs/kv/diagnostics")
    // A section without that panel opens its home page.
    expect(docsRailTarget(section("blob"), panel)).toBe("/docs/blob")
    expect(docsRailTarget(section("kv"), null)).toBe("/docs/kv")
  })

  it("moves previous and next inside the panel only", () => {
    const document: DocsDocument = { nodes: [], toc: [] }
    const queue = section("queue")
    const inPanel = docsPageResponse(manifest, { page: page("/docs/queue/diagnostics/queue_disabled"), section: queue }, document)
    expect([inPanel.prev?.path, inPanel.next?.path]).toEqual(["/docs/queue/diagnostics", "/docs/queue/diagnostics/queue_missing_region"])
    const outside = docsPageResponse(manifest, { page: page("/docs/queue/configure"), section: queue }, document)
    expect([outside.prev?.path, outside.next?.path]).toEqual(["/docs/queue", undefined])
  })
})

describe("pages that search engines do not index", () => {
  it("reads `seo.index: false` and leaves those pages out of the indexed pages", () => {
    expect(page("/docs/queue/diagnostics/queue_disabled").seo).toEqual({ index: false })
    const indexed = docsIndexedPages(manifest).map(candidate => candidate.path)
    expect(indexed).toContain("/docs/queue/diagnostics")
    expect(indexed).toContain("/docs/queue/diagnostics/queue_provider_failed")
    expect(indexed).not.toContain("/docs/queue/diagnostics/queue_disabled")
    expect(indexed).not.toContain("/docs/kv/diagnostics/kv_invalid_cursor")
  })
})
