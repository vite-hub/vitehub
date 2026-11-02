import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { parse as parseYaml } from "yaml"
import { parseFrontmatter } from "comark/parse"
import * as v from "valibot"

import { docsPageSchema, docsSectionSchema, expandDottedKeys, type DocsPageFrontmatter } from "./schema.ts"

import type { DocsManifest, DocsPage, DocsSection } from "./types.ts"

export interface DocsManifestOptions {
  /** Absolute path of the content directory. */
  dir: string
  /** URL prefix whose folders are sections, such as `/docs`. Its folder is `<dir>/<base>`. */
  base: string
}

/** A page whose frontmatter or section file does not match the schema. The build stops on it. */
export class DocsContentError extends Error {
  constructor(file: string, issues: readonly v.BaseIssue<unknown>[]) {
    const details = issues.map(issue => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`).join("; ")
    super(`Invalid docs frontmatter in ${file}: ${details}`)
    this.name = "DocsContentError"
  }
}

/** Read the whole content directory and compute sections, pages, and their order. */
export function createDocsManifest(options: DocsManifestOptions): DocsManifest {
  const base = normalizeBase(options.base)
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
    .filter(file => !isInside(file, baseDir))
    .map(file => readPage(options.dir, file, "", pathOf(relative(options.dir, file))))
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    base,
    root: existsSync(rootFile) ? readPage(options.dir, rootFile, "index", base) : null,
    sections,
    pages,
  }
}

function readSection(dir: string, base: string, id: string, index: number): DocsSection {
  const sectionDir = join(dir, base, id)
  const pages = listMarkdown(sectionDir)
    .map(file => {
      const pageId = idOf(relative(sectionDir, file))
      return readPage(dir, file, pageId, pageId === "index" ? `${base}/${id}` : `${base}/${id}/${pageId}`)
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
    path: `${base}/${id}`,
    title: navigation.title ?? overview?.sourceTitle ?? titleCase(id),
    description: overview?.description ?? null,
    icon: navigation.icon ?? overview?.icon ?? null,
    category: navigation.category ?? null,
    related: navigation.related ?? [],
    order: navigation.order ?? index,
    pages,
  }
}

function readPage(dir: string, file: string, id: string, path: string): DocsPage {
  const { data } = parseFrontmatter(readFileSync(file, "utf8"))
  const expanded = expandDottedKeys(data)
  // `navigation: false` hides the page even when dotted keys such as `navigation.title` also set fields.
  if (data.navigation === false) expanded.navigation = false
  const frontmatter: DocsPageFrontmatter = parse(file, docsPageSchema, expanded)
  const navigation = frontmatter.navigation === false ? undefined : frontmatter.navigation
  const layout = frontmatter.layout ?? "article"
  return {
    id,
    path: path || "/",
    file: relative(dir, file).replaceAll("\\", "/"),
    title: navigation?.title ?? frontmatter.title,
    sourceTitle: frontmatter.title,
    description: frontmatter.description ?? null,
    icon: frontmatter.icon ?? null,
    layout,
    ...(frontmatter.tutorial ? { tutorial: frontmatter.tutorial } : {}),
    ...(frontmatter.codePanel ? { codePanel: true } : {}),
    sidebar: frontmatter.sidebar ?? true,
    toc: frontmatter.toc ?? layout !== "landing",
    kind: navigation?.kind ?? null,
    group: navigation?.group ?? null,
    navigation: frontmatter.navigation !== false,
    order: navigation?.order ?? Number.MAX_SAFE_INTEGER,
  }
}

function parse<const TSchema extends v.GenericSchema>(file: string, schema: TSchema, input: unknown): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input)
  if (!result.success) throw new DocsContentError(file, result.issues)
  return result.output
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

function pathOf(file: string): string {
  const id = idOf(file)
  return id === "index" ? "/" : `/${id}`
}

function normalizeBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "")
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function titleCase(input: string): string {
  return input.split(/[-/]/g).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
}
