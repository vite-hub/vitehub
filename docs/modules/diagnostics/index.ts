import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { defineNuxtModule, useLogger } from "nuxt/kit"
import { parse as parseYaml } from "yaml"

import { readDiagnosticCodes } from "./catalog.ts"
import { diagnosticPages, diagnosticsFolder } from "./pages.ts"

import type { DiagnosticGuide } from "./pages.ts"

/**
 * Writes one page for each diagnostic code of the package catalogs into `content/docs/<section>/diagnostics/`, with an
 * Overview that opens a sidebar panel, and `content/docs/reference/diagnostics.md`. Git ignores these files. A guide in
 * `docs/diagnostics/<CODE>.md` replaces the generated body of its code and makes the page indexed.
 *
 * It runs before `@vite-hub/docs` reads the content folder, so the pages are part of the manifest.
 */
export default defineNuxtModule({
  meta: { name: "vitehub-diagnostics" },
  setup(_options, nuxt) {
    const logger = useLogger("vitehub-diagnostics")
    const docsRoot = nuxt.options.rootDir
    const started = performance.now()
    const written = writeDiagnosticPages({ root: resolve(docsRoot, ".."), content: join(docsRoot, "content"), guides: join(docsRoot, "diagnostics") })
    logger.info(`${written.pages} diagnostic pages (${written.changed} changed) in ${Math.round(performance.now() - started)} ms`)
  },
})

export interface WriteDiagnosticPagesOptions {
  /** Repository root, with the `packages/` folder. */
  root: string
  /** The docs content folder. */
  content: string
  /** Folder of the hand-written guides. */
  guides: string
}

/** Writes the pages that changed and removes the pages of removed codes. Unchanged files keep their time, so the dev server does not restart. */
export function writeDiagnosticPages(options: WriteDiagnosticPagesOptions): { pages: number, changed: number } {
  const docs = join(options.content, "docs")
  const sections = readdirSync(docs, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  const sectionTitles: Record<string, string> = {}
  const limits: Record<string, string> = {}
  for (const section of sections) {
    const navigation = join(docs, section, ".navigation.yml")
    const parsed: unknown = existsSync(navigation) ? parseYaml(readFileSync(navigation, "utf8")) : null
    const title = parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string" ? parsed.title : null
    if (title) sectionTitles[section] = title
    const limitsFile = join(docs, section, "limits-and-errors.md")
    if (existsSync(limitsFile)) limits[section] = readFileSync(limitsFile, "utf8")
  }
  const pages = diagnosticPages({
    codes: readDiagnosticCodes(options.root),
    sectionTitles,
    limits,
    guides: readGuides(options.guides),
    repository: "https://github.com/vite-hub/vitehub",
  })

  let changed = 0
  for (const [file, source] of pages) {
    const target = join(options.content, file)
    if (existsSync(target) && readFileSync(target, "utf8") === source) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
    changed++
  }
  // The diagnostics folders hold generated pages only.
  for (const section of sections) {
    const folder = join(docs, section, diagnosticsFolder)
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder)) {
      if (pages.has(`docs/${section}/${diagnosticsFolder}/${entry}`)) continue
      rmSync(join(folder, entry), { force: true, recursive: true })
      changed++
    }
  }
  return { pages: pages.size, changed }
}

function readGuides(dir: string): Record<string, DiagnosticGuide> {
  if (!existsSync(dir)) return {}
  const guides: Record<string, DiagnosticGuide> = {}
  for (const entry of readdirSync(dir)) {
    const code = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\.md$/.exec(entry)?.[1]
    if (!code) continue
    const source = readFileSync(join(dir, entry), "utf8")
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source)
    guides[code] = match ? { frontmatter: match[1]!, body: match[2]! } : { frontmatter: "", body: source }
  }
  return guides
}
