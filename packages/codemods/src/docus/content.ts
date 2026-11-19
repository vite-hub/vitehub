import type { FollowUp } from "../types.ts"

/** Frontmatter fields that `@vite-hub/docs` accepts on a page. Any other field fails its build with `DOCS_CONTENT_INVALID`. */
const pageFields = new Set(["title", "description", "tagline", "eyebrow", "credits", "keywords", "icon", "layout", "tutorial", "codePanel", "sidebar", "toc", "navigation", "seo"])
const navigationFields = new Set(["title", "order", "group", "kind", "panel"])
const seoFields = new Set(["title", "description", "image", "index"])
const sectionFields = new Set(["title", "icon", "order", "category", "group", "fold", "related"])
const layouts = new Set(["article", "tutorial", "landing", "home"])

/** Nuxt UI page components that Docus pages use and comark-ui does not render. */
const nuxtUiBlock = /^\s*::(u-[a-z-]+)/

/** A path segment without the `1.` order prefix of Nuxt Content, and that order. */
export function stripOrder(segment: string): { name: string, order?: number } {
  const match = /^(\d+)\.(.+)$/.exec(segment)
  return match ? { name: match[2]!, order: Number(match[1]) } : { name: segment }
}

/** One top-level frontmatter entry: its key and its lines, with the indented lines of a nested value. */
interface Entry {
  key: string
  lines: string[]
}

function parseEntries(lines: readonly string[]): Entry[] | undefined {
  const entries: Entry[] = []
  for (const text of lines) {
    if (/^\s/.test(text) || text.startsWith("- ") || text === "") {
      const last = entries.at(-1)
      if (!last) return text === "" ? entries : undefined
      last.lines.push(text)
      continue
    }
    if (text.startsWith("#")) continue
    const match = /^([\w.$-]+|"[^"]+"|'[^']+'):(?:\s|$)/.exec(text)
    if (!match) return undefined
    entries.push({ key: match[1]!.replace(/^["']|["']$/g, ""), lines: [text] })
  }
  return entries
}

/** The scalar value of `key: value`, without quotes. */
function scalar(text: string): string {
  return text.slice(text.indexOf(":") + 1).trim().replace(/^(["'])(.*)\1$/, "$2")
}

function yamlString(value: string): string {
  return /^[\w ./@-]+$/.test(value) && !/^(?:true|false|null|yes|no|\d)/i.test(value) ? value : JSON.stringify(value)
}

/** The child entries of a nested entry, such as `seo:` and its indented keys. */
function children(entry: Entry): Array<{ key: string, text: string }> | undefined {
  const rest = entry.lines.slice(1).filter(text => text.trim() !== "")
  if (!rest.length) return []
  const indent = /^\s+/.exec(rest[0]!)?.[0] ?? ""
  const result: Array<{ key: string, text: string }> = []
  for (const text of rest) {
    if (!text.startsWith(indent)) return undefined
    const inner = text.slice(indent.length)
    if (/^\s/.test(inner)) return undefined
    const match = /^([\w$-]+):(?:\s|$)/.exec(inner)
    if (!match) return undefined
    result.push({ key: match[1]!, text: inner })
  }
  return result
}

export interface PageMove {
  code: string
  followUps: FollowUp[]
}

/**
 * Moves the frontmatter of a Docus page to the fields of `@vite-hub/docs`: `seo.ogImage` becomes `seo.image`,
 * `navigation.icon` becomes `icon`, a page without `title` takes its first `# Heading`, the order prefix of the file
 * becomes `navigation.order`, and `::callout` becomes `::note`. Fields with no equivalent go, and the report lists them.
 */
export function movePage(file: string, code: string, order: number | undefined): PageMove {
  const followUps: FollowUp[] = []
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(code)
  let body = match ? code.slice(match[0].length) : code
  const entries = match ? parseEntries(match[1]!.split(/\r?\n/)) : []
  if (!entries) {
    return { code, followUps: [{ file, line: 1, message: "The codemod could not read this frontmatter. Check that it uses only the @vite-hub/docs page fields, or the build fails with DOCS_CONTENT_INVALID." }] }
  }
  const out: string[] = []
  let title = entries.find(entry => entry.key === "title")
  let icon = entries.find(entry => entry.key === "icon") ? undefined : ""
  let hasOrder = false
  for (const entry of entries) {
    const first = entry.lines[0]!
    if (entry.key.startsWith("navigation.")) {
      const field = entry.key.slice("navigation.".length)
      if (field === "icon" && icon === "") icon = scalar(first)
      else if (navigationFields.has(field)) {
        hasOrder ||= field === "order"
        out.push(...entry.lines)
      }
      else followUps.push({ file, message: `The codemod dropped ${entry.key}, which @vite-hub/docs does not read.` })
      continue
    }
    if (entry.key.startsWith("seo.")) {
      const field = entry.key.slice("seo.".length)
      if (field === "ogImage") out.push(`seo.image:${first.slice(first.indexOf(":") + 1)}`)
      else if (seoFields.has(field)) out.push(...entry.lines)
      else followUps.push({ file, message: `The codemod dropped ${entry.key}, which @vite-hub/docs does not read.` })
      continue
    }
    if (!pageFields.has(entry.key)) {
      followUps.push({ file, message: `The codemod dropped the ${entry.key} field, which @vite-hub/docs does not read.${entry.key === "links" ? " Put the links in the page body, for example as a ::card-group." : ""}` })
      continue
    }
    if (entry.key === "layout" && !layouts.has(scalar(first))) {
      followUps.push({ file, message: `layout ${scalar(first)} is not a @vite-hub/docs layout, so the codemod dropped it. Use article, tutorial, landing, or home.` })
      continue
    }
    if (entry.key === "navigation" || entry.key === "seo") {
      const value = scalar(first)
      if (entry.key === "navigation" && value === "true") continue
      if (value) {
        out.push(...entry.lines)
        continue
      }
      const nested = children(entry)
      if (!nested) {
        followUps.push({ file, message: `The codemod could not read ${entry.key}. Check that it uses only the fields that @vite-hub/docs reads.` })
        out.push(...entry.lines)
        continue
      }
      const kept: string[] = []
      for (const child of nested) {
        if (entry.key === "navigation" && child.key === "icon") {
          if (icon === "") icon = scalar(child.text)
          continue
        }
        if (entry.key === "seo" && child.key === "ogImage") {
          kept.push(`  image:${child.text.slice(child.text.indexOf(":") + 1)}`)
          continue
        }
        if ((entry.key === "navigation" ? navigationFields : seoFields).has(child.key)) {
          hasOrder ||= entry.key === "navigation" && child.key === "order"
          kept.push(`  ${child.text}`)
        }
        else followUps.push({ file, message: `The codemod dropped ${entry.key}.${child.key}, which @vite-hub/docs does not read.` })
      }
      if (kept.length) out.push(`${entry.key}:`, ...kept)
      continue
    }
    out.push(...entry.lines)
  }
  if (!title) {
    const heading = /^# +(.+?)\s*#*\s*$/m.exec(body)
    if (heading) {
      title = { key: "title", lines: [`title: ${yamlString(heading[1]!)}`] }
      // The page layout draws the title as the only h1.
      body = body.replace(heading[0], "").replace(/^\s*\n/, "")
    }
    else {
      const name = stripOrder(file.split("/").at(-1)!.replace(/\.md$/, "")).name
      title = { key: "title", lines: [`title: ${yamlString(name === "index" ? "Overview" : name.replace(/[-_]/g, " ").replace(/^\w/, letter => letter.toUpperCase()))}`] }
      followUps.push({ file, line: 1, message: "This page has no title and no # heading, so the codemod named it after the file. Check the title." })
    }
    out.unshift(...title.lines)
  }
  if (icon) out.push(`icon: ${yamlString(icon)}`)
  if (order !== undefined && !hasOrder && !/^navigation:\s*false\s*$/m.test(out.join("\n"))) out.push(`navigation.order: ${order}`)
  body = body.replace(/^(\s*:{2,})callout\b/gm, "$1note")
  const lineOffset = out.length + 2
  body.split("\n").forEach((text, index) => {
    const block = nuxtUiBlock.exec(text)
    if (block) followUps.push({ file, line: index + 1 + lineOffset, message: `::${block[1]} is a Nuxt UI component, which the docs Markdown does not render. Rewrite the block with comark-ui blocks, such as ::card-group, or with the home layout.` })
  })
  return { code: `---\n${out.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`, followUps }
}

/** Keeps the `.navigation.yml` fields that `@vite-hub/docs` reads, and adds the order prefix of the folder. */
export function moveSection(file: string, code: string | undefined, order: number | undefined): PageMove | undefined {
  const followUps: FollowUp[] = []
  const entries = code === undefined ? [] : parseEntries(code.split(/\r?\n/))
  if (!entries) return { code: code!, followUps: [{ file, message: "The codemod could not read this file. Keep only title, icon, order, category, group, fold, and related, or the build fails." }] }
  const out: string[] = []
  for (const entry of entries) {
    if (sectionFields.has(entry.key)) out.push(...entry.lines.filter(text => text !== ""))
    else followUps.push({ file, message: `The codemod dropped ${entry.key}, which @vite-hub/docs does not read in .navigation.yml.` })
  }
  if (order !== undefined && !entries.some(entry => entry.key === "order")) out.push(`order: ${order}`)
  if (!out.length) return undefined
  return { code: `${out.join("\n")}\n`, followUps }
}
