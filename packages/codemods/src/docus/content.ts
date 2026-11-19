import { parseDocument, stringify } from "yaml"

import { codemodError } from "../error-diagnostics.ts"

import type { FollowUp } from "../types.ts"

const pageFields = new Set(["title", "description", "tagline", "eyebrow", "credits", "keywords", "icon", "layout", "tutorial", "codePanel", "sidebar", "toc", "navigation", "seo"])
const navigationFields = new Set(["title", "order", "group", "kind", "panel"])
const seoFields = new Set(["title", "description", "image", "index"])
const sectionFields = new Set(["title", "icon", "order", "category", "group", "fold", "related"])
const layouts = new Set(["article", "tutorial", "landing", "home"])

export function stripOrder(segment: string): { name: string, order?: number } {
  const match = /^\d+(?:\.\d+)+$/.test(segment) ? null : /^(\d+)\.(.+)$/.exec(segment)
  return match ? { name: match[2]!, order: Number(match[1]) } : { name: segment }
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readMapping(file: string, code: string): Record<string, unknown> {
  try {
    const document = parseDocument(code, { stringKeys: true })
    if (document.errors.length || document.warnings.length) throw new Error("Unsupported YAML")
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    if (value === null && !document.contents) return {}
    if (mapping(value)) return value
  }
  catch {
    // Report the original file rather than a partial rewrite.
  }
  throw codemodError(`${file}:1: Expected a YAML mapping that can be migrated. No files changed.`)
}

function keepFields(fields: Record<string, unknown>, allowed: Set<string>, dropped: (key: string) => void): void {
  for (const key of Object.keys(fields)) {
    if (allowed.has(key)) continue
    dropped(key)
    delete fields[key]
  }
}

function expandFields(file: string, fields: Record<string, unknown>, key: string): void {
  for (const field of Object.keys(fields)) {
    if (!field.startsWith(`${key}.`)) continue
    const name = field.slice(key.length + 1)
    fields[key] ??= {}
    const nested = fields[key]
    if (!mapping(nested) || Object.hasOwn(nested, name)) throw codemodError(`${file}:1: Conflicting ${key} frontmatter fields.`)
    Object.defineProperty(nested, name, { value: fields[field], writable: true, configurable: true, enumerable: true })
    delete fields[field]
  }
}

export interface PageMove {
  code: string
  followUps: FollowUp[]
}

export function movePage(file: string, code: string, order: number | undefined): PageMove {
  const followUps: FollowUp[] = []
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(code)
  const rest = opening ? code.slice(opening[0].length) : code
  const closing = opening ? /^---[ \t]*(?:\r?\n|$)/m.exec(rest) : null
  if (opening && !closing) throw codemodError(`${file}:1: The YAML frontmatter has no closing delimiter.`)
  const frontmatter = closing ? readMapping(file, rest.slice(0, closing.index)) : {}
  const body = closing ? rest.slice(closing.index + closing[0].length) : code
  const dropped = (key: string) => followUps.push({ file, message: `The codemod dropped the ${key} field, which @vite-hub/docs does not read.${key === "links" ? " Put the links in the page body, for example as a ::card-group." : ""}` })

  if (Object.hasOwn(frontmatter, "path")) throw codemodError(`${file}:1: Migrate the custom page path by hand.`)
  expandFields(file, frontmatter, "navigation")
  expandFields(file, frontmatter, "seo")
  keepFields(frontmatter, pageFields, dropped)
  if (frontmatter.title !== undefined && typeof frontmatter.title !== "string") throw codemodError(`${file}:1: Expected title to be a string.`)
  if (frontmatter.layout !== undefined && (typeof frontmatter.layout !== "string" || !layouts.has(frontmatter.layout))) {
    followUps.push({ file, message: `layout ${String(frontmatter.layout)} is not a @vite-hub/docs layout, so the codemod dropped it. Use article, tutorial, landing, or home.` })
    delete frontmatter.layout
  }
  if (mapping(frontmatter.seo)) {
    const seo = frontmatter.seo
    if (Object.hasOwn(seo, "ogImage")) {
      seo.image ??= seo.ogImage
      delete seo.ogImage
    }
    keepFields(seo, seoFields, key => dropped(`seo.${key}`))
  }
  else if (frontmatter.seo !== undefined) throw codemodError(`${file}:1: Expected seo to be a YAML mapping.`)

  if (frontmatter.navigation === true) delete frontmatter.navigation
  if (mapping(frontmatter.navigation)) {
    frontmatter.icon ??= frontmatter.navigation.icon
    if (frontmatter.icon === undefined) delete frontmatter.icon
    delete frontmatter.navigation.icon
    keepFields(frontmatter.navigation, navigationFields, key => dropped(`navigation.${key}`))
    if (!Object.keys(frontmatter.navigation).length) delete frontmatter.navigation
  }
  else if (frontmatter.navigation !== undefined && frontmatter.navigation !== false) throw codemodError(`${file}:1: Expected navigation to be a boolean or YAML mapping.`)
  if (order !== undefined && frontmatter.navigation !== false) {
    if (mapping(frontmatter.navigation)) frontmatter.navigation.order ??= order
    else frontmatter["navigation.order"] = order
  }

  const lines = body.split("\n")
  const firstBodyLine = closing ? code.slice(0, code.length - body.length).split("\n").length : 1
  let fence: string | undefined
  let title = typeof frontmatter.title === "string" ? frontmatter.title : undefined
  const output = lines.flatMap((text, index) => {
    const marker = /^[ \t]*(?:(?:>|[-+*]|\d+[.)])[ \t]+)*(`{3,}|~{3,})(.*)$/.exec(text)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      return [text]
    }
    if (marker) {
      fence = marker[1]
      return [text]
    }
    if (/^(?: {4}|\t)/.test(text)) return [text]
    if (/(?:\]\(|\]:\s*|href\s*=\s*["'])(?:\s*<?)(?![a-z][\w+.-]*:|\/\/)[^\s)>"']+\.md(?:[\s)>"'#?]|$)/i.test(text)) {
      throw codemodError(`${file}:${firstBodyLine + index}: Convert local Markdown file links to their Nuxt Content page URLs before migrating.`)
    }
    const heading = /^ {0,3}# +(.+?)(?: +#+)?\s*$/.exec(text)
    if (!title && heading) {
      title = heading[1]
      return []
    }
    const block = /^ {0,3}::(u-[a-z-]+)/.exec(text)
    if (block) followUps.push({ file, line: firstBodyLine + index, message: `::${block[1]} is a Nuxt UI component, which the docs Markdown does not render. Rewrite the block with comark-ui blocks, such as ::card-group, or with the home layout.` })
    return [text.replace(/^( {0,3}:{2,})callout\b/, "$1note")]
  })
  if (!title) {
    const name = stripOrder(file.split("/").at(-1)!.replace(/\.md$/, "")).name
    title = name === "index" ? "Overview" : name.replace(/[-_]/g, " ").replace(/^\w/, letter => letter.toUpperCase())
    followUps.push({ file, line: 1, message: "This page has no title and no # heading, so the codemod named it after the file. Check the title." })
  }
  delete frontmatter.title
  if (mapping(frontmatter.navigation) && Object.keys(frontmatter.navigation).length === 1 && frontmatter.navigation.order !== undefined) {
    frontmatter["navigation.order"] = frontmatter.navigation.order
    delete frontmatter.navigation
  }
  const yaml = stringify({ title, ...frontmatter }, { lineWidth: 0 })
  return { code: `---\n${yaml}---\n\n${output.join("\n").replace(/^\r?\n(?:\r?\n)*/, "")}`, followUps }
}

export function moveSection(file: string, code: string | undefined, order: number | undefined): PageMove {
  const followUps: FollowUp[] = []
  const fields = code === undefined ? {} : readMapping(file, code)
  keepFields(fields, sectionFields, key => followUps.push({ file, message: `The codemod dropped ${key}, which @vite-hub/docs does not read in .navigation.yml.` }))
  if (order !== undefined) fields.order ??= order
  return { code: stringify(fields, { lineWidth: 0 }), followUps }
}
