import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

import { parse as parseYaml } from "yaml"
import { parseFrontmatter } from "comark/parse"

import { docsManifestPages, normalizeDocsBase } from "./navigation.ts"
import { docsPageOf, docsPagePath } from "./page.ts"
import { docsFrontmatter, docsPageSchema, docsSectionSchema } from "./schema.ts"

import type { z } from "zod"
import type { DocsManifest, DocsPage, DocsSection } from "./types.ts"

export interface DocsManifestOptions {
  /** Absolute path of the content directory. */
  dir: string
  /** URL prefix whose folders are sections, such as `/docs`. Its folder is `<dir>/<base>`. */
  base: string
}

/** A page whose frontmatter or section file does not match the schema. The build stops on it. */
export class DocsContentError extends Error {
  constructor(file: string, issues: readonly { path: readonly PropertyKey[], message: string }[]) {
    const details = issues.map(issue => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")
    super(`Invalid docs frontmatter in ${file}: ${details}`)
    this.name = "DocsContentError"
  }
}

/** Read the whole content directory and compute sections, pages, and their order. */
export function createDocsManifest(options: DocsManifestOptions): DocsManifest {
  const base = normalizeDocsBase(options.base)
  const baseDir = join(options.dir, base)
  const rootFile = join(baseDir, "index.md")
  const sections = existsSync(baseDir)
    ? readdirSync(baseDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map((entry, index) => readSection(options.dir, base, entry.name, index))
        .filter(section => section.pages.length > 0)
        .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    : []
  const pages = listMarkdown(options.dir)
    .filter(file => !isInside(file, baseDir) || (dirname(file) === dirname(rootFile) && file !== rootFile))
    .map(file => readPage(options.dir, file, "", docsPagePath(relative(options.dir, file))))
    .sort((left, right) => left.path.localeCompare(right.path))
  const manifest: DocsManifest = {
    base,
    root: existsSync(rootFile) ? readPage(options.dir, rootFile, "index", base) : null,
    sections,
    pages,
  }
  const paths = new Map<string, string>()
  for (const page of docsManifestPages(manifest)) {
    const existing = paths.get(page.path)
    if (existing) throw new DocsContentError(join(options.dir, page.file), [{ path: ["path"], message: `${page.path} is also produced by ${existing}` }])
    paths.set(page.path, page.file)
  }
  return manifest
}

function readSection(dir: string, base: string, id: string, index: number): DocsSection {
  const sectionDir = join(dir, base, id)
  const pages = listMarkdown(sectionDir)
    .map(file => {
      const pageId = idOf(relative(sectionDir, file))
      return readPage(dir, file, pageId, pageId === "index" ? joinPath(base, id) : joinPath(base, id, pageId))
    })
    .sort((left, right) => {
      if (left.id === "index") return -1
      if (right.id === "index") return 1
      return left.order - right.order || left.id.localeCompare(right.id)
    })
  const navigationFile = join(sectionDir, ".navigation.yml")
  const navigation = existsSync(navigationFile) ? parse(navigationFile, docsSectionSchema, parseYaml(readFileSync(navigationFile, "utf8")) ?? {}) : {}
  const overview = pages.find(page => page.id === "index")
  return {
    id,
    path: joinPath(base, id),
    title: navigation.title ?? overview?.sourceTitle ?? titleCase(id),
    description: overview?.description ?? null,
    icon: navigation.icon ?? overview?.icon ?? null,
    category: navigation.category ?? null,
    group: navigation.group ?? null,
    fold: navigation.fold ?? false,
    related: navigation.related ?? [],
    order: navigation.order ?? index,
    pages,
  }
}

function readPage(dir: string, file: string, id: string, path: string): DocsPage {
  const { data } = parseFrontmatter(readFileSync(file, "utf8"))
  return docsPageOf(parse(file, docsPageSchema, docsFrontmatter(data)), { id, path, file: relative(dir, file).replaceAll("\\", "/") })
}

function parse<TOutput>(file: string, schema: z.ZodType<TOutput>, input: unknown): TOutput {
  const result = schema.safeParse(input)
  if (!result.success) throw new DocsContentError(file, result.error.issues)
  return result.data
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
}

function isInside(file: string, dir: string): boolean {
  const path = relative(dir, file)
  return !path.startsWith("..") && path !== file
}

/** `index.md` is the folder's page: `operations/index.md` is `operations`. */
function idOf(file: string): string {
  return file.replaceAll("\\", "/").replace(/\.md$/, "").replace(/(^|\/)index$/, "") || "index"
}

/** With the base `/`, the section `guide` is `/guide`, not `//guide`. */
function joinPath(base: string, ...segments: string[]): string {
  return `${base.replace(/\/+$/, "")}/${segments.join("/")}`
}

function titleCase(input: string): string {
  return input.split(/[-/]/g).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
}
