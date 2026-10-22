import { contentEditorComponents } from "@vite-hub/content/editor"

import type { DocumentComponent } from "@vite-hub/content"
import type { ConsoleDocumentComponent } from "../definitions"

/**
 * Menus of the document body editor, as plain data so they can be tested without an editor. Item `kind`s are Nuxt UI
 * editor handler names; `table`, `image`, and `component` are handlers the body editor adds.
 */

export interface ConsoleSlashItem {
  /** Comark tag of a `component` item. */
  component?: string
  /** The Markdown that the item writes, shown on the right as a hint, such as `##`. */
  description?: string
  icon: string
  /** Other words that find the item, such as `h2` or `subtitle`. */
  keywords: string[]
  kind: string
  label: string
  level?: 1 | 2 | 3
}

export interface ConsoleSlashLabel {
  label: string
  type: "label"
}

export type ConsoleSlashGroup = Array<ConsoleSlashLabel | ConsoleSlashItem>

/** The collection components keyed by tag, as Content declares them, for the codec that Content owns. */
export function consoleComponentRecord(components: readonly ConsoleDocumentComponent[] | undefined): Record<string, DocumentComponent> {
  return Object.fromEntries((components ?? []).map(component => [component.name, { kind: component.kind, props: component.props }]))
}

/**
 * The collection components the editor can register: the ones Content's `contentEditorComponents()` keeps, so the
 * Console and the server codec of a live room have the same schema.
 */
export function consoleEditorComponents(components: readonly ConsoleDocumentComponent[] | undefined): ConsoleDocumentComponent[] {
  const kept = new Set(contentEditorComponents(consoleComponentRecord(components), definition => definition.name))
  return (components ?? []).filter(component => kept.has(component.name))
}

/** Default attributes of a new component: each prop's declared default. */
export function consoleComponentDefaults(component: ConsoleDocumentComponent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(component.props).flatMap(([name, prop]) => (prop.default === undefined ? [] : [[name, prop.default]])))
}

/** The `/` menu: basic blocks, media, then the components of the collection. */
export function consoleSlashGroups(components: readonly ConsoleDocumentComponent[]): ConsoleSlashGroup[] {
  const groups: ConsoleSlashGroup[] = [
    [
      { label: "Basic blocks", type: "label" },
      { icon: "i-lucide-pilcrow", keywords: ["paragraph", "plain", "p"], kind: "paragraph", label: "Text" },
      { description: "#", icon: "i-lucide-heading-1", keywords: ["h1", "title", "big"], kind: "heading", label: "Heading 1", level: 1 },
      { description: "##", icon: "i-lucide-heading-2", keywords: ["h2", "subtitle", "section"], kind: "heading", label: "Heading 2", level: 2 },
      { description: "###", icon: "i-lucide-heading-3", keywords: ["h3", "subheading", "small"], kind: "heading", label: "Heading 3", level: 3 },
      { description: "-", icon: "i-lucide-list", keywords: ["ul", "unordered", "bullet", "list"], kind: "bulletList", label: "Bulleted list" },
      { description: "1.", icon: "i-lucide-list-ordered", keywords: ["ol", "ordered", "number", "list"], kind: "orderedList", label: "Numbered list" },
      { description: ">", icon: "i-lucide-text-quote", keywords: ["blockquote", "citation"], kind: "blockquote", label: "Quote" },
      { description: "```", icon: "i-lucide-square-code", keywords: ["code block", "snippet", "pre", "fence"], kind: "codeBlock", label: "Code" },
      { description: "---", icon: "i-lucide-minus", keywords: ["hr", "separator", "line", "rule", "horizontal"], kind: "horizontalRule", label: "Divider" },
      { icon: "i-lucide-table", keywords: ["grid", "rows", "columns", "spreadsheet"], kind: "table", label: "Table" },
    ],
    [
      { label: "Media", type: "label" },
      { icon: "i-lucide-image", keywords: ["picture", "photo", "img", "media", "blob", "upload"], kind: "image", label: "Image…" },
    ],
  ]
  if (components.length) {
    groups.push([
      { label: "Components", type: "label" },
      ...components.map((component): ConsoleSlashItem => ({
        component: component.name,
        description: component.kind === "inline" ? `:${component.name}` : `::${component.name}`,
        icon: component.kind === "inline" ? "i-lucide-text-cursor-input" : "i-lucide-component",
        keywords: [component.name, "component", "mdc", ...(component.description?.toLowerCase().split(/\W+/).filter(Boolean) ?? [])],
        kind: "component",
        label: component.label,
      })),
    ])
  }
  return groups
}

/** Block types that "Turn into" converts between, in menu order. */
export const consoleTurnIntoItems = [
  { icon: "i-lucide-pilcrow", kind: "paragraph", label: "Text" },
  { icon: "i-lucide-heading-1", kind: "heading", label: "Heading 1", level: 1 },
  { icon: "i-lucide-heading-2", kind: "heading", label: "Heading 2", level: 2 },
  { icon: "i-lucide-heading-3", kind: "heading", label: "Heading 3", level: 3 },
  { icon: "i-lucide-list", kind: "bulletList", label: "Bulleted list" },
  { icon: "i-lucide-list-ordered", kind: "orderedList", label: "Numbered list" },
  { icon: "i-lucide-text-quote", kind: "blockquote", label: "Quote" },
  { icon: "i-lucide-square-code", kind: "codeBlock", label: "Code" },
] as const

/** Node types that "Turn into" can convert. Others, such as tables and components, only move, duplicate, and delete. */
export const consoleConvertibleNodes: ReadonlySet<string> = new Set(["blockquote", "bulletList", "codeBlock", "heading", "listItem", "orderedList", "paragraph"])

/** Splits a stored file into its frontmatter block, delimiters included, and the Markdown body after it. */
export function splitConsoleFrontmatter(text: string): { body: string, frontmatter: string } {
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(text)
  return match ? { body: text.slice(match[0].length), frontmatter: match[0] } : { body: text, frontmatter: "" }
}

/** A heading anchor such as `getting-started`, for links to a section of the body. */
export function consoleHeadingSlug(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}
