import { validateSourceFile } from "comark-content/plugins/schema-validation/validate"
import type { ContentFile, ContentOptions, JsonSchema } from "comark-content"
import type { SourceItem } from "@vite-hub/source"

import { contentSource, createContentInstance } from "./content-source.ts"
import { contentDocumentUrl } from "./documents.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { ContentCommit } from "./commit-cache.ts"
import type { ContentSourceInput } from "./content-source.ts"
import type { ContentDocumentUrl } from "./documents.ts"

/**
 * `vitehub content check` and `content.check()`: rules that read the parsed documents of a Source, with no built HTML
 * and no network. Errors keep a commit from becoming the head of a `github()` Source. Warnings only report.
 */

type ContentSourceItem = SourceItem<string, unknown, object>

/** The rules of a check, by name. */
export type ContentCheckRule =
  | "parse" | "frontmatter" | "link" | "route" | "anchor" | "title" | "description" | "duplicate" | "heading-order"

export type ContentCheckSeverity = "error" | "warning"

/** The diagnostic code of each rule. `CONTENT_R0069` is a check that could not run. */
export type ContentCheckCode =
  | "CONTENT_R0060" | "CONTENT_R0061" | "CONTENT_R0062" | "CONTENT_R0063" | "CONTENT_R0064"
  | "CONTENT_R0065" | "CONTENT_R0066" | "CONTENT_R0067" | "CONTENT_R0068"

/** The code and severity of each rule. Only errors keep a commit from becoming the head. */
export const contentCheckRules: Readonly<Record<ContentCheckRule, { code: ContentCheckCode, severity: ContentCheckSeverity }>> = {
  "parse": { code: "CONTENT_R0060", severity: "error" },
  "frontmatter": { code: "CONTENT_R0061", severity: "error" },
  "link": { code: "CONTENT_R0062", severity: "error" },
  "route": { code: "CONTENT_R0063", severity: "warning" },
  "anchor": { code: "CONTENT_R0064", severity: "warning" },
  "title": { code: "CONTENT_R0065", severity: "warning" },
  "description": { code: "CONTENT_R0066", severity: "warning" },
  "duplicate": { code: "CONTENT_R0067", severity: "warning" },
  "heading-order": { code: "CONTENT_R0068", severity: "warning" },
}

/**
 * The search limits of `@vite-hub/docs` `seoAudit`, from common site audits: a title of 10 to 60 characters and a
 * description of 70 to 160.
 */
export const contentCheckLimits = {
  title: { min: 10, max: 60 },
  description: { min: 70, max: 160 },
} as const

/** One problem that a check found. */
export interface ContentCheckFinding {
  /** The Content source name, such as `docs`. */
  source: string
  /** The file in the Source, such as `guide/start.md`. */
  path: string
  /** The page URL of the document, such as `/guide/start`, or null for a document without a page. */
  url: string | null
  /** The line in the file, from 1, or null when the check cannot tell. */
  line: number | null
  rule: ContentCheckRule
  code: ContentCheckCode
  severity: ContentCheckSeverity
  /** One sentence that says what is wrong and how to fix it. */
  message: string
}

/** The result of `content.check()` and `vitehub content check`. */
export interface ContentCheckResult {
  /** True when no finding is an error. */
  ok: boolean
  /** The Sources that the check read, with the commit of a `github()` Source. */
  sources: Array<{ source: string, sha: string | null, pages: number }>
  errors: number
  warnings: number
  /** Errors first, then by Source, file, and line. */
  findings: ContentCheckFinding[]
}

/** `defineContent({ check })`: what the link rule skips, and the site origin of absolute links. */
export interface ContentCheckOptions {
  /**
   * Link targets that other routes serve, so the link rules skip them: paths such as `/learn`, globs such as
   * `/docs/*\/diagnostics/**`, or regular expressions. A missing page below a first path segment that holds pages, such
   * as `/docs/kvv` next to `/docs/kv`, is an error. Other missing targets, such as `/learn`, are warnings, because
   * another route of the app may serve them.
   */
  ignoreLinks?: ReadonlyArray<string | RegExp>
  /** The public origin, such as `https://vitehub.dev`. Absolute links to it are checked like `/` links. */
  site?: string
  /**
   * The `<title>` pattern of the site, such as `%s · ViteHub`. The title rule measures the title inside it, as search
   * engines see it. A title that already holds the text around `%s` stays as it is.
   */
  titleTemplate?: string
}

/** The documents of one Source to check: the files as stored, and the documents that parsed. */
export interface ContentCheckInput {
  source: string
  files: readonly ContentSourceItem[]
  items: readonly ContentFile[]
  /** Files that did not load or parse. */
  failures?: ReadonlyArray<{ path: string, message: string }>
  schema?: JsonSchema
  url?: ContentDocumentUrl
  options?: ContentCheckOptions
  /** Other configured Sources. The candidate's own documents remain authoritative. */
  targets?: readonly (Pick<ContentCheckInput, "items" | "url"> & {
    /** An incomplete target set stays unknown unless its configured URL scope excludes the unresolved link. */
    unavailable?: string
  })[]
}

/** Parsed documents of one Source, and the files that did not parse. */
export interface ParsedContentFiles {
  commit?: Omit<ContentCommit, "files">
  failures: Array<{ path: string, message: string }>
}

/**
 * Load and parse every document of `input`. Returns the documents, or the error when a document does not parse. Index
 * plugins such as `sql-query` write their tables on `file:bulk:load`, so the parse skips that hook: a check must not
 * change them.
 */
export async function parseContentDocuments(name: string, input: ContentSourceInput, options: ContentOptions): Promise<Omit<ContentCommit, "files"> | string> {
  // A fresh memory cache, so `snapshot()` reads the parsed documents back without loading the files again.
  const instance = createContentInstance(name, input, { ...options, cache: {}, logger: false, onError: "throw" })
  const { hooks } = instance
  const callHook = hooks.callHook
  hooks.callHook = ((hook: string, ...args: unknown[]) => hook === "file:bulk:load" ? Promise.resolve() : Reflect.apply(callHook, hooks, [hook, ...args])) as typeof callHook
  try {
    await instance.init({ partial: false, ignoreCache: true })
    const { items } = await instance.snapshot()
    return { manifest: await instance.manifest(), items }
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  finally {
    await instance.dispose()
  }
}

/**
 * Parse the files of one Source. Parse errors, such as YAML errors, do not name the document, so on a failure each
 * document parses alone to find it. With `all`, the parse names every file that fails and still parses the others, so
 * the rules run on them. Without it, the parse stops at the first file that fails.
 */
export async function parseContentFiles(
  name: string,
  files: readonly ContentSourceItem[],
  source: { prefix?: string, schema?: JsonSchema },
  options: ContentOptions,
  all = false,
): Promise<ParsedContentFiles> {
  const parse = (list: readonly ContentSourceItem[]) => parseContentDocuments(name, contentSource({ items: async () => [...list] }, source), options)
  const parsed = await parse(files)
  if (typeof parsed !== "string") return { commit: parsed, failures: [] }
  const failures: ParsedContentFiles["failures"] = []
  const failed = new Set<ContentSourceItem>()
  for (const item of files) {
    const error = await parse([item])
    if (typeof error !== "string") continue
    failures.push({ path: item.path ?? item.key, message: error })
    failed.add(item)
    if (!all) break
  }
  if (!failures.length) return { failures: [{ path: "", message: parsed }] }
  if (!all) return { failures }
  const rest = await parse(files.filter(item => !failed.has(item)))
  return typeof rest === "string" ? { failures } : { commit: rest, failures }
}

const markdownExtension = /^\.(?:md|markdown)$/i

/** A page of the Source: a Markdown document with a URL. */
interface CheckedPage {
  item: ContentFile
  path: string
  url: string
  text: string | undefined
  ids: Set<string>
}

function fileText(item: ContentSourceItem | undefined): string | undefined {
  if (!item) return
  if (typeof item.content === "string") return item.content
  if (item.content instanceof Uint8Array) return new TextDecoder().decode(item.content)
}

/** The 1-based line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) line++
  return line
}

/** The line of a top-level frontmatter key, such as `title` or `navigation.order`, or null. */
function frontmatterLine(text: string | undefined, key: string): number | null {
  if (!text?.startsWith("---")) return null
  const end = text.indexOf("\n---", 3)
  const lines = text.slice(0, end === -1 ? undefined : end).split("\n")
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^(?:${escaped}|"${escaped}"|'${escaped}')\\s*:`)
  const index = lines.findIndex(line => pattern.test(line))
  return index === -1 ? null : index + 1
}

/** The top-level key of a validation data path, such as `title` for `$.title.0` or `navigation.order` for `$["navigation.order"]`. */
function topKey(dataPath: string): string {
  const match = dataPath.match(/^\$(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\.)*")\])/)
  if (!match) return ""
  if (match[1]) return match[1]
  try {
    return String(JSON.parse(match[2]!))
  }
  catch {
    return ""
  }
}

/** A glob as a regular expression: `*` matches within one segment, `**` across segments, `?` one character. */
function globPattern(glob: string): RegExp {
  let source = ""
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === "?") source += "[^/]"
    else if (char !== "*") source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    else if (glob[index + 1] !== "*") source += "[^/]*"
    else if (glob[index + 2] === "/") {
      source += "(?:.*/)?"
      index += 2
    }
    else {
      source += ".*"
      index++
    }
  }
  return new RegExp(`^${source}$`)
}

/** A matcher of paths, globs, and regular expressions. */
function linkMatcher(patterns: ContentCheckOptions["ignoreLinks"]): (value: string) => boolean {
  const exact = new Set<string>()
  const tests: RegExp[] = []
  for (const pattern of patterns ?? []) {
    if (typeof pattern !== "string") tests.push(pattern)
    else if (/[*?]/.test(pattern)) tests.push(globPattern(pattern))
    else exact.add(pattern)
  }
  return value => exact.has(value) || tests.some((test) => {
    test.lastIndex = 0
    return test.test(value)
  })
}

/** Lowercase, decoded, without a trailing slash or a `.md` suffix: how Content matches a page URL. */
function normalizePath(path: string): string {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  }
  catch {}
  decoded = decoded.toLowerCase().replace(/\.(?:md|markdown)$/, "").replace(/\/index$/, "/")
  return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded
}

/** The static start of a URL pattern, such as `/blog/` for `/blog/:id`. `/` for a function or no pattern. */
function urlBase(url: ContentDocumentUrl | undefined): string {
  if (typeof url !== "string") return "/"
  const token = url.indexOf(":")
  const start = (token === -1 ? url : url.slice(0, token)).toLowerCase()
  return start.slice(0, start.lastIndexOf("/") + 1) || "/"
}

function firstSegment(path: string): string {
  return path.split("/")[1] ?? ""
}

/** Every `href` and `to` of a node tree, and every `id`, in document order. */
function walk(nodes: ContentFile["nodes"], links: string[], ids: Set<string>, headings: number[]): void {
  for (const node of nodes) {
    if (!Array.isArray(node)) continue
    const [tag, attributes, ...children] = node
    if (attributes && typeof attributes === "object") {
      const { href, to, id } = attributes as Record<string, unknown>
      if (typeof id === "string" && id) ids.add(id)
      for (const value of [href, to]) if (typeof value === "string" && value) links.push(value)
    }
    if (typeof tag === "string" && /^h[1-6]$/.test(tag)) headings.push(Number(tag[1]))
    walk(children, links, ids, headings)
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** A value of `data.seo.<key>` or of the dotted key `seo.<key>`. */
function seoValue(data: Record<string, unknown>, key: string): unknown {
  const seo = data.seo
  if (seo !== null && typeof seo === "object" && key in seo) return Reflect.get(seo, key)
  return data[`seo.${key}`]
}

/** A title inside the `<title>` pattern of the site. */
function withTemplate(title: string | undefined, template: string | undefined): string | undefined {
  if (!title || !template?.includes("%s")) return title
  const around = template.replace("%s", "").trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
  return around && title.toLowerCase().includes(around.toLowerCase()) ? title : template.replace("%s", title)
}

function pageUrl(item: ContentFile, pattern: ContentDocumentUrl | undefined): string | null {
  if (pattern === undefined) return item.path
  try {
    return contentDocumentUrl(pattern, { id: item.path.replace(/^\/+/, ""), data: item.data })
  }
  catch {
    return null
  }
}

/** Run every rule on the documents of one Source, in memory and with no network. `pages` counts the Markdown pages with a URL. */
export function checkContentDocuments(input: ContentCheckInput): { pages: number, findings: ContentCheckFinding[] } {
  const { source, options = {} } = input
  const findings: ContentCheckFinding[] = []
  const add = (rule: ContentCheckRule, at: { path: string, url: string | null, line: number | null }, message: string) => {
    findings.push({ source, ...at, rule, ...contentCheckRules[rule], message })
  }
  // A parse error, such as one of YAML, can quote the file over several lines. The first line names the problem.
  const firstLine = (message: string) => message.split("\n")[0]!.trim().replace(/\.$/, "")
  for (const failure of input.failures ?? []) add("parse", { path: failure.path, url: null, line: null }, failure.path ? `${failure.path} does not parse: ${firstLine(failure.message)}. Fix the file so it loads.` : `The documents of Source "${source}" do not load: ${firstLine(failure.message)}.`)

  const files = new Map(input.files.map(file => [file.path ?? file.key, file]))
  const pages = new Map<string, CheckedPage>()
  const documents: Array<{ item: ContentFile, path: string, url: string | null, text: string | undefined }> = []
  for (const item of input.items) {
    if (item.meta.kind !== "document") continue
    const path = item.meta.key.startsWith(`${source}/`) ? item.meta.key.slice(source.length + 1) : item.meta.key
    const raw = fileText(files.get(path))
    const url = pageUrl(item, input.url)
    documents.push({ item, path, url, text: raw })
    if (input.schema) {
      for (const issue of validateSourceFile(item, input.schema, { source }).issues) {
        const field = topKey(issue.dataPath)
        add("frontmatter", { path, url, line: frontmatterLine(raw, field) }, `${issue.message.replace(/\.$/, "")}. Fix the frontmatter to match the schema of Source "${source}".`)
      }
    }
    if (url !== null && markdownExtension.test(item.meta.extension)) pages.set(normalizePath(url), { item, path, url, text: raw, ids: new Set() })
  }

  // A missing target is an error below a first path segment that holds pages, and a warning elsewhere, where another
  // route may serve it. Links outside the static part of the URL pattern, such as `/about` for `/blog/:id`, belong to
  // other routes.
  const targets = new Map<string, { ids: Set<string> }>()
  for (const source of input.targets ?? []) {
    for (const item of source.items) {
      if (item.meta.kind !== "document" || !markdownExtension.test(item.meta.extension)) continue
      const url = pageUrl(item, source.url)
      if (url === null || targets.has(normalizePath(url))) continue
      const ids = new Set<string>()
      walk(item.nodes ?? [], [], ids, [])
      targets.set(normalizePath(url), { ids })
    }
  }
  // A page in the checked commit takes precedence over another Source with the same URL.
  for (const [url, page] of pages) targets.set(url, page)
  const scope = new Set([...targets.keys()].map(firstSegment))
  const base = urlBase(input.url)
  const ignored = linkMatcher(options.ignoreLinks)
  let origin: string | undefined
  try {
    origin = options.site ? new URL(options.site).origin : undefined
  }
  catch {}
  const walked = new Map<CheckedPage, { links: string[], headings: number[] }>()
  for (const page of pages.values()) {
    const links: string[] = []
    const headings: number[] = []
    walk(page.item.nodes ?? [], links, page.ids, headings)
    walked.set(page, { links, headings })
  }

  for (const page of pages.values()) {
    const { links, headings } = walked.get(page)!
    const seen = new Set<string>()
    let cursor = 0
    for (const link of links) {
      if (seen.has(link)) continue
      seen.add(link)
      let line: number | null = null
      if (page.text) {
        let index = page.text.indexOf(link, cursor)
        if (index === -1) index = page.text.indexOf(link)
        if (index !== -1) {
          line = lineAt(page.text, index)
          cursor = index + link.length
        }
      }
      const at = { path: page.path, url: page.url, line }
      let url: URL
      try {
        url = new URL(link, `http://content.invalid${page.url}`)
      }
      catch {
        continue
      }
      const internal = url.origin === "http://content.invalid" || (origin !== undefined && url.origin === origin)
      if (!internal) continue
      const target = normalizePath(url.pathname)
      const hash = url.hash.length > 1 ? url.hash.slice(1) : ""
      if (ignored(url.pathname) || ignored(`${url.pathname}${url.hash}`) || ignored(link)) continue
      const found = targets.get(target)
      if (!found) {
        const unavailable = input.targets?.find(source => {
          if (!source.unavailable) return false
          // A reader's paths, a function URL, and a root pattern can serve any internal path. Without their
          // documents, only a known fixed URL or prefix can prove that this Source is irrelevant to the link.
          if (typeof source.url !== "string") return true
          if (!source.url.includes(":")) return target === normalizePath(source.url)
          const base = normalizePath(urlBase(source.url))
          return base === "/" || target === base || target.startsWith(`${base}/`)
        })
        if (unavailable) throw contentErrorDiagnostics.CONTENT_R0069({ message: `[vitehub] ${page.path}: ${page.url} links to ${url.pathname}, but Source "${unavailable.unavailable}" could not load its link targets. Retry the check when that Source is available.` })
      }
      if (!found && !target.startsWith(base) && `${target}/` !== base) continue
      if (!found) {
        if (scope.has(firstSegment(target))) add("link", at, `${page.url} links to ${url.pathname}, which is no page of Source "${source}". Fix the link, or add the path to \`check.ignoreLinks\` when another route serves it.`)
        else add("route", at, `${page.url} links to ${url.pathname}, which no page of Source "${source}" serves. Add the path to \`check.ignoreLinks\` when another route of the app serves it, or fix the link.`)
        continue
      }
      if (!hash) continue
      let id = hash
      try {
        id = decodeURIComponent(hash)
      }
      catch {}
      if (!found.ids.has(id)) add("anchor", at, `${page.url} links to ${url.pathname}#${id}, but that page has no heading with id "${id}". Link to an existing heading.`)
    }

    // A layout renders the title as the page's h1, so a body without an h1 starts below it.
    const levels = headings.includes(1) ? headings : [1, ...headings]
    const skip = levels.findIndex((level, index) => index > 0 && level > levels[index - 1]! + 1)
    if (skip > 0) add("heading-order", { path: page.path, url: page.url, line: null }, `${page.url} skips a heading level, h${levels[skip - 1]} → h${levels[skip]}. Go down one level at a time.`)
  }

  // The search rules of `@vite-hub/docs` `seoAudit`, on pages that search engines index.
  const { title: titleLimit, description: descriptionLimit } = contentCheckLimits
  const indexed: Array<{ page: CheckedPage, title?: string, description?: string }> = []
  for (const page of pages.values()) {
    const data = page.item.data
    if (seoValue(data, "noindex") === true || seoValue(data, "index") === false) continue
    const canonical = text(seoValue(data, "canonical"))
    if (canonical && normalizePath(canonical.replace(/^https?:\/\/[^/]+/i, "")) !== normalizePath(page.url)) continue
    const title = withTemplate(text(seoValue(data, "title")) ?? text(data.title), options.titleTemplate)
    const description = text(seoValue(data, "description")) ?? text(data.description)
    const at = { path: page.path, url: page.url }
    if (!title) add("title", { ...at, line: null }, `${page.url} has no title. Set \`title\` in its frontmatter.`)
    else if (title.length < titleLimit.min || title.length > titleLimit.max) add("title", { ...at, line: frontmatterLine(page.text, text(seoValue(data, "title")) ? "seo.title" : "title") ?? frontmatterLine(page.text, "title") }, `${page.url} has a title of ${title.length} characters, "${title}". Keep it between ${titleLimit.min} and ${titleLimit.max}, with \`seo.title\` when the heading must stay.`)
    if (!description) add("description", { ...at, line: null }, `${page.url} has no description. Set \`description\` in its frontmatter.`)
    else if (description.length < descriptionLimit.min || description.length > descriptionLimit.max) add("description", { ...at, line: frontmatterLine(page.text, text(seoValue(data, "description")) ? "seo.description" : "description") ?? frontmatterLine(page.text, "description") }, `${page.url} has a description of ${description.length} characters. Keep it between ${descriptionLimit.min} and ${descriptionLimit.max}.`)
    indexed.push({ page, ...(title ? { title } : {}), ...(description ? { description } : {}) })
  }
  for (const field of ["title", "description"] as const) {
    const groups = new Map<string, CheckedPage[]>()
    for (const entry of indexed) {
      const value = entry[field]
      if (value) groups.set(value, [...groups.get(value) ?? [], entry.page])
    }
    for (const [value, group] of groups) {
      if (group.length < 2) continue
      for (const page of group) {
        const others = group.filter(other => other !== page).map(other => other.url).join(", ")
        add("duplicate", { path: page.path, url: page.url, line: frontmatterLine(page.text, field) }, `${page.url} shares the ${field} "${value}" with ${others}. Give each page its own.`)
      }
    }
  }
  return { pages: pages.size, findings }
}

/** Errors first, then by Source, file, and line. */
export function sortContentFindings(findings: ContentCheckFinding[]): ContentCheckFinding[] {
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)
    || a.source.localeCompare(b.source) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
}

/** The result of the findings of one or more Sources. */
export function contentCheckResult(sources: ContentCheckResult["sources"], findings: ContentCheckFinding[]): ContentCheckResult {
  const errors = findings.filter(finding => finding.severity === "error").length
  return { ok: errors === 0, sources, errors, warnings: findings.length - errors, findings: sortContentFindings(findings) }
}

/** `guide.md:12` or `guide.md`. */
export function contentFindingLocation(finding: Pick<ContentCheckFinding, "path" | "line">): string {
  return finding.line === null ? finding.path : `${finding.path}:${finding.line}`
}

/**
 * Why a commit fails the check, for `content.sources.head()`: the count and the first three errors, or undefined when it
 * has no error. Warnings do not count.
 */
export function contentCheckReason(findings: readonly ContentCheckFinding[]): string | undefined {
  const errors = findings.filter(finding => finding.severity === "error")
  if (!errors.length) return
  const shown = errors.slice(0, 3).map(error => `${contentFindingLocation(error)}: ${error.message} (${error.code})`)
  const more = errors.length > shown.length ? ` and ${errors.length - shown.length} more` : ""
  return `${errors.length} check ${errors.length === 1 ? "error" : "errors"}: ${shown.join("; ")}${more}. \`vitehub content check\` lists them all.`
}
