import type { DiagnosticCode } from "./catalog.ts"

/** The docs section of each package catalog. Core packages share the Development section. */
export const diagnosticSections: Record<string, string> = {
  "agent": "agents",
  "auth": "auth",
  "blob": "blob",
  "browser": "browser",
  "bundle": "development",
  "channels": "channels",
  "cli": "development",
  "cms": "cms",
  "comments": "comments",
  "connections": "connections",
  "content": "content",
  "database": "database",
  "decisions": "decisions",
  "email": "email",
  "env": "env",
  "forms": "forms",
  "forge": "forge",
  "gateways": "gateways",
  "i18n": "i18n",
  "internal": "development",
  "kv": "kv",
  "markdown-template": "agents",
  "mcp": "mcp",
  "presets": "agents",
  "queue": "queue",
  "rate-limit": "rate-limit",
  "realtime": "realtime",
  "runtime": "development",
  "sandbox": "sandbox",
  "schedule": "schedule",
  "shell": "shell",
  "source": "source",
  "ui": "ui",
  "vite-hub": "development",
  "workflow": "workflows",
  "workspace": "workspace",
}

/** The folder of the diagnostics panel in each section, and the URL segment of every code page. */
export const diagnosticsFolder = "diagnostics"

/** A hand-written page for one code, from `docs/diagnostics/<CODE>.md`. */
export interface DiagnosticGuide {
  /** Frontmatter lines as written, without the `---` fences. */
  frontmatter: string
  body: string
}

export interface DiagnosticPagesInput {
  codes: DiagnosticCode[]
  /** Section id to section title, such as `queue` to `Queue`. */
  sectionTitles: Record<string, string>
  /** Section id to the Markdown of its `limits-and-errors.md`, when it has one. */
  limits: Record<string, string>
  /** Code to its hand-written guide. A guide makes the page indexed. */
  guides: Record<string, DiagnosticGuide>
  repository: string
}

/** Code family letters of numbered codes, such as `QUEUE_C0001`, and their group in the sidebar. */
const families: Record<string, string> = { C: "Configuration errors", B: "Build errors", R: "Runtime errors" }

export function diagnosticPath(section: string, code: string): string {
  return `/docs/${section}/${diagnosticsFolder}/${code.toLowerCase()}`
}

/** The section of a code, or `null` for a package without a docs section. */
export function diagnosticSection(code: Pick<DiagnosticCode, "pkg">): string | null {
  return diagnosticSections[code.pkg] ?? null
}

/** Files to write below `content/`, by path: one Overview and one page per code for each section, and the list of every section. */
export function diagnosticPages(input: DiagnosticPagesInput): Map<string, string> {
  const pages = new Map<string, string>()
  const bySection = new Map<string, DiagnosticCode[]>()
  for (const code of input.codes) {
    const section = diagnosticSection(code)
    if (!section) throw new Error(`Package "${code.pkg}" has diagnostic ${code.code} but no docs section. Add it to diagnosticSections in docs/modules/diagnostics/pages.ts.`)
    bySection.set(section, [...bySection.get(section) ?? [], code])
  }
  for (const guide of Object.keys(input.guides)) {
    if (!input.codes.some(code => code.code === guide)) throw new Error(`docs/diagnostics/${guide}.md has no diagnostic code ${guide} in any package catalog.`)
  }
  const sections = [...bySection.keys()].sort((left, right) => (input.sectionTitles[left] ?? left).localeCompare(input.sectionTitles[right] ?? right))
  for (const section of sections) {
    const codes = bySection.get(section)!
    const title = input.sectionTitles[section] ?? section
    const details = limitsSections(input.limits[section] ?? "")
    pages.set(`docs/${section}/${diagnosticsFolder}/index.md`, overviewPage(section, title, codes, input.guides))
    // The panel lists the codes in the order of the Overview.
    const ordered = [...groupCodes(codes).values()].flat()
    for (const code of codes) {
      pages.set(`docs/${section}/${diagnosticsFolder}/${code.code.toLowerCase()}.md`, codePage(section, title, code, details.get(code.code) ?? null, input.guides[code.code] ?? null, input.repository, ordered.indexOf(code)))
    }
  }
  pages.set("docs/reference/diagnostics.md", allPage(sections.map(section => ({ section, title: input.sectionTitles[section] ?? section, count: bySection.get(section)!.length }))))
  return pages
}

/** The sidebar group of a code: its catalog comment, else its family letter, else `Errors`. */
export function diagnosticGroup(code: Pick<DiagnosticCode, "code" | "group">): string {
  if (code.group) return code.group.replace(/^Config errors$/i, "Configuration errors")
  const family = /_([CBR])\d{4}$/.exec(code.code)?.[1]
  return family ? families[family]! : "Errors"
}

/** The one line that tells what a code means: its `why`, else the message of its first call site. */
export function diagnosticSummary(code: DiagnosticCode): string | null {
  const text = code.why ?? code.sites.find(site => site.message)?.message ?? null
  return text ? text.replace(/^\[vitehub(?::[\w-]+)?\]\s*/, "").trim() : null
}

function overviewPage(section: string, title: string, codes: DiagnosticCode[], guides: Record<string, DiagnosticGuide>): string {
  const groups = groupCodes(codes)
  const lines = [
    "---",
    `title: ${yamlString(`${title} diagnostics`)}`,
    `description: ${yamlString(`Find every ${title} error code, what it means, how to fix it, and the source that raises it in your app.`)}`,
    "navigation.title: Diagnostics",
    "navigation.panel: true",
    "navigation.order: 1000",
    "icon: i-ph-warning-circle-light",
    "---",
    "",
    generatedNotice,
    "",
    `Each ${title} error has a stable \`code\`. Its \`docs\` link opens the page of that code. ${codes.length === 1 ? "This page lists the code" : `This page lists all ${codes.length} codes`}, and [All diagnostics](/docs/reference/diagnostics) lists every primitive.`,
    "",
  ]
  for (const [group, groupCodes] of groups) {
    // The site draws the compact list, a tenth of the HTML of a table. The table stays in the Markdown copy for agents.
    lines.push(`## ${group}`, "", `::page-list{group="${group}" compact}`, "| Code | What happened |", "| --- | --- |")
    for (const code of groupCodes) {
      const guide = guides[code.code] ? " (guide)" : ""
      lines.push(`| [\`${code.code}\`](${diagnosticPath(section, code.code)})${guide} | ${tableCell(diagnosticSummary(code) ?? "See the page of the code.")} |`)
    }
    lines.push("::", "")
  }
  return lines.join("\n")
}

function codePage(section: string, sectionTitle: string, code: DiagnosticCode, details: string | null, guide: DiagnosticGuide | null, repository: string, order: number): string {
  const summary = diagnosticSummary(code)
  const description = summary ? truncate(summary, 155) : `The ${code.code} diagnostic of ${sectionTitle}.`
  const frontmatter = [
    `title: ${code.code}`,
    `description: ${yamlString(description)}`,
    `navigation.group: ${yamlString(diagnosticGroup(code))}`,
    `navigation.order: ${order + 1}`,
    // A generated page is thin, so search engines skip it. A hand-written guide is indexed.
    ...guide ? [] : ["seo.index: false"],
    ...guide?.frontmatter.trim() ? [guide.frontmatter.trim()] : [],
  ]
  const lines = ["---", ...dedupeFrontmatter(frontmatter), "---", "", generatedNotice, ""]
  if (guide) {
    lines.push(guide.body.trim(), "")
  }
  else {
    if (code.why) lines.push("## What happened", "", quote(code.why), "")
    const messages = [...new Set(code.sites.map(site => site.message).filter((message): message is string => !!message))]
    if (!code.why && messages.length) {
      lines.push("## What happened", "", messages.length === 1 ? "The error message is:" : "The error message is one of:", "", ...messages.map(message => `- \`${inlineCode(message.replace(/^\[vitehub(?::[\w-]+)?\]\s*/, ""))}\``), "")
    }
    if (code.fix) lines.push("## How to fix it", "", markdownText(code.fix), "")
    if (details) lines.push("## Details", "", rewriteAnchors(details, section), "")
    if (!code.why && !messages.length && !code.fix && !details) lines.push(`The message of this error tells what went wrong. Read it with \`error.why\`, or \`error.message\` in a log.`, "")
  }
  lines.push("## Source", "", `\`${code.code}\` belongs to the \`${code.pkg}\` package. ${sourceLinks(code, repository)}`, "")
  lines.push(`See [all ${sectionTitle} diagnostics](/docs/${section}/${diagnosticsFolder}).`, "")
  return lines.join("\n")
}

function allPage(sections: { section: string, title: string, count: number }[]): string {
  const total = sections.reduce((sum, entry) => sum + entry.count, 0)
  return [
    "---",
    "title: All diagnostics",
    `description: ${yamlString("Find every ViteHub error code, grouped by primitive, with links to its cause, fix, and source in the package that raises it.")}`,
    "navigation.title: All diagnostics",
    "navigation.group: Runtime and output",
    "navigation.order: 59",
    "icon: i-ph-warning-circle-light",
    "---",
    "",
    generatedNotice,
    "",
    `ViteHub has ${total} error codes. Each one has a page with what happened, how to fix it, and where the code raises it. Open the primitive of the code, or read [Errors and diagnostics](/docs/reference/errors-diagnostics) for the error contract.`,
    "",
    "| Primitive | Codes |",
    "| --- | --- |",
    ...sections.map(entry => `| [${entry.title}](/docs/${entry.section}/${diagnosticsFolder}) | ${entry.count} |`),
    "",
  ].join("\n")
}

const generatedNotice = "<!-- Generated by docs/modules/diagnostics from the package catalogs. Write a guide in docs/diagnostics/<CODE>.md instead of editing this file. -->"

function groupCodes(codes: DiagnosticCode[]): Map<string, DiagnosticCode[]> {
  const groups = new Map<string, DiagnosticCode[]>()
  // Runtime errors first: they are the ones that an application handles.
  const rank = (group: string) => /^runtime/i.test(group) ? 0 : /^config/i.test(group) ? 1 : /^build/i.test(group) ? 2 : 3
  for (const code of [...codes].sort((left, right) => rank(diagnosticGroup(left)) - rank(diagnosticGroup(right)) || left.code.localeCompare(right.code))) {
    const group = diagnosticGroup(code)
    groups.set(group, [...groups.get(group) ?? [], code])
  }
  return groups
}

/** `### CODE` sections of a `limits-and-errors.md` page, by code. */
export function limitsSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = markdown.split("\n")
  let current: string | null = null
  let body: string[] = []
  let fence = false
  const close = () => {
    if (current) sections.set(current, body.join("\n").trim())
    current = null
    body = []
  }
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence
    const heading = fence ? null : /^(#{1,3})\s+`?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`?\s*$/.exec(line)
    if (heading?.[1] === "###") {
      close()
      current = heading[2]!
      continue
    }
    if (!fence && /^#{1,3}\s/.test(line)) {
      close()
      continue
    }
    if (current) body.push(line)
  }
  close()
  return sections
}

/** A link to another code on the same page, such as `(#queue_disabled)`, opens the page of that code. */
function rewriteAnchors(markdown: string, section: string): string {
  return markdown
    .replace(/\]\(#([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\)/g, (_match, anchor: string) => `](${diagnosticPath(section, anchor.toUpperCase())})`)
    .replace(/\]\(#([\w-]+)\)/g, (_match, anchor: string) => `](/docs/${section}/limits-and-errors#${anchor})`)
}

function sourceLinks(code: DiagnosticCode, repository: string): string {
  const link = (file: string, line: number) => `[\`${file.replace(/^packages\/[^/]+\//, "")}\`](${repository}/blob/main/${file}#L${line})`
  const sites = code.sites.slice(0, 5)
  const defined = `Its catalog entry is in ${link(code.file, code.line)}.`
  if (!sites.length) return defined
  const raised = sites.map(site => link(site.file, site.line)).join(", ")
  const more = code.sites.length > sites.length ? `, and ${code.sites.length - sites.length} more places` : ""
  return `${defined} It is raised in ${raised}${more}.`
}

function dedupeFrontmatter(lines: string[]): string[] {
  // A guide's field replaces the generated one with the same key.
  const keyOf = (line: string) => /^([\w.]+):/.exec(line)?.[1] ?? line
  const flat = lines.flatMap(line => line.split("\n"))
  const last = new Map<string, number>()
  flat.forEach((line, index) => last.set(keyOf(line), index))
  return flat.filter((line, index) => !/^[\w.]+:/.test(line) || last.get(keyOf(line)) === index)
}

function quote(text: string): string {
  return markdownText(text.replace(/^\[vitehub(?::[\w-]+)?\]\s*/, "")).split("\n").map(line => `> ${line}`).join("\n")
}

function tableCell(text: string): string {
  return markdownText(text).replaceAll("|", "\\|").replaceAll("\n", " ")
}

/** Catalog text is plain text with inline code. `<name>` placeholders and `<` outside code must not parse as HTML. */
export function markdownText(text: string): string {
  return text.split("`").map((part, index) => index % 2 === 0 ? part.replaceAll("<", "\\<").replaceAll(">", "\\>") : part).join("`")
}

function inlineCode(text: string): string {
  return text.replaceAll("`", "'").replaceAll("\n", " ")
}

function truncate(text: string, length: number): string {
  const flat = text.replaceAll("\n", " ").replaceAll("`", "")
  return flat.length <= length ? flat : `${flat.slice(0, length - 1).trimEnd()}…`
}

function yamlString(text: string): string {
  return JSON.stringify(text)
}
