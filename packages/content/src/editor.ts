import { getSchema } from "@tiptap/core"
import { parseMarkdown } from "comark"
import { renderMarkdown } from "comark/render"
import { ComarkKit, comarkSpecs, comarkToPmDoc, createSerializer, defineComarkComponent, pmDocToComark } from "comark-tiptap"

import type { AnyExtension, JSONContent } from "@tiptap/core"
import type { RealtimeEditor, RealtimeVerifyResult } from "@vite-hub/realtime"
import type { ComarkComponentDefinition, ComarkComponentExports, ComarkHelpers } from "comark-tiptap"
import type { DocumentComponent } from "./documents.ts"

/** What the Content editor reads from a collection: the Comark components its bodies may use, keyed by tag. */
export interface ContentEditorCollection {
  readonly components?: Readonly<Record<string, DocumentComponent>>
}

/** Node names that ComarkKit already uses. A component with one of these names would replace a built-in node. */
const reservedNodeNames = new Set(["blockquote", "comment", "doc", "heading", "image", "paragraph", "picture", "table", "template", "text"])
const componentTag = /^[a-z][a-z0-9-]*$/

/** The parse options that comark-tiptap forces, so the server and the browser read Markdown alike. */
const parseOptions = { autoClose: false, headingIds: false } as const

/**
 * The collection components as comark-tiptap component definitions: valid Comark tags that do not shadow a built-in
 * node, in definition order. Pass `define` to add a node view, such as `defineComarkVueComponent`. The server and every
 * browser editor of a collection must build its components with this function, so their schemas match.
 */
export function contentEditorComponents<TExports = ComarkComponentExports>(
  components: ContentEditorCollection["components"],
  define: (definition: ComarkComponentDefinition) => TExports = definition => defineComarkComponent(definition) as TExports,
): TExports[] {
  return Object.entries(components ?? {})
    .filter(([tag]) => componentTag.test(tag) && !reservedNodeNames.has(tag))
    .map(([name, component]) => define({
      kind: component.kind ?? "block",
      name,
      props: Object.fromEntries(Object.entries(component.props ?? {}).map(([prop, value]) => [prop, value.default === undefined ? { type: value.type } : { default: value.default, type: value.type }])),
    }))
}

/** Options of `ComarkKit` that every Content editor shares. Live editing turns off the local undo history, which Yjs owns. */
export const contentEditorKitOptions: Readonly<{ starterKit: Readonly<{ undoRedo: false }> }> = Object.freeze({ starterKit: Object.freeze({ undoRedo: false as const }) })

type ComarkNode = string | readonly unknown[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value ?? null)
}

/** A declared prop as Comark writes it: `type="info"` for a string, `:count="3"` for the other types. */
function propValue(attrs: Record<string, unknown>, name: string, type: string): unknown {
  if (Object.hasOwn(attrs, name)) {
    const value = attrs[name]
    if (type === "string" || String(value) !== value) return value
    if (type === "number") return Number(value)
    if (type === "boolean") return value === "" || value === "true"
    return value
  }
  if (!Object.hasOwn(attrs, `:${name}`)) return undefined
  const raw = attrs[`:${name}`]
  if (String(raw) !== raw) return raw
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

/** Component attributes with every declared prop under its own name, its declared default when it is missing. */
function componentAttrs(attrs: Record<string, unknown>, component: DocumentComponent): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attrs)) {
    const name = key.startsWith(":") ? key.slice(1) : key
    if (!component.props?.[name]) result[key] = value
  }
  for (const [name, prop] of Object.entries(component.props ?? {})) {
    const value = propValue(attrs, name, prop.type)
    const resolved = value === undefined ? prop.default : value
    if (resolved !== undefined) result[name] = resolved
  }
  return result
}

/**
 * The parts of a Comark tree that carry meaning: adjacent text merged, declared component props with their defaults,
 * and without the empty `component` node that a reference-link definition leaves.
 */
function normalizeNodes(nodes: readonly unknown[], components: Readonly<Record<string, DocumentComponent>>): ComarkNode[] {
  const result: ComarkNode[] = []
  for (const node of nodes) {
    if (String(node) === node) {
      const last = result.at(-1)
      if (String(last) === last) result[result.length - 1] = last + node
      else result.push(node)
      continue
    }
    if (!Array.isArray(node)) continue
    const [tag, rawAttrs, ...children] = node
    const attrs = isRecord(rawAttrs) ? rawAttrs : {}
    if (tag === "component" && !children.length && !Object.keys(attrs).length) continue
    const component = String(tag) === tag && Object.hasOwn(components, tag) ? components[tag] : undefined
    result.push([tag, component ? componentAttrs(attrs, component) : attrs, ...normalizeNodes(children, components)])
  }
  return result
}

/** Each tag once, with how it first appears: as a block of the body, or inside other content. */
function collectTags(nodes: readonly ComarkNode[], tags: Map<string, { block: boolean, empty: boolean }>, block = true): void {
  for (const node of nodes) {
    if (!Array.isArray(node)) continue
    const [tag, attrs, ...children] = node
    if (String(tag) === tag && !tags.has(tag)) tags.set(tag, { block, empty: !children.length && !(isRecord(attrs) && Object.keys(attrs).length) })
    collectTags(children, tags, false)
  }
}

const htmlTags = new Set(["abbr", "aside", "audio", "bdi", "bdo", "button", "cite", "data", "details", "dfn", "div", "figcaption", "figure", "form", "iframe", "ins", "kbd", "mark", "q", "samp", "section", "small", "source", "sub", "summary", "sup", "time", "track", "u", "var", "video", "wbr"])

/** A construct in words, such as `task lists`, `<kbd> HTML`, `the ::callout component`, or `:rocket:`. */
function describeTag(tag: string, seen: { block: boolean, empty: boolean }): string {
  if (tag === "input") return "task lists"
  if (tag === "span") return "[text]{.class} spans and footnotes"
  if (htmlTags.has(tag)) return `<${tag}> HTML`
  if (seen.block) return `the ::${tag} component`
  // An inline tag without attributes or content is how Comark reads an emoji shortcode.
  return seen.empty ? `:${tag}:` : `the :${tag} component`
}

function tagOf(node: ComarkNode | undefined): string | undefined {
  return Array.isArray(node) && String(node[0]) === node[0] ? node[0] : undefined
}

/** The first difference between two normalized trees that keep the same tags, in words. */
function firstChange(stored: readonly ComarkNode[], written: readonly ComarkNode[], parent: string | undefined): string | undefined {
  if (stored.length !== written.length) {
    const index = stored.findIndex((node, position) => stableJson(node) !== stableJson(written[position]))
    const tag = tagOf(stored[index])
    if (tag === "ul" || tag === "ol") return "lists that follow each other with different markers"
    return parent ? `the structure of <${parent}>` : tag ? `the blocks around <${tag}>` : "the block structure"
  }
  for (let index = 0; index < stored.length; index++) {
    const left = stored[index]!
    const right = written[index]!
    if (stableJson(left) === stableJson(right)) continue
    if (!Array.isArray(left) || !Array.isArray(right)) return parent ? `text inside <${parent}>` : "text"
    const [tag, attrs, ...children] = left
    const [, writtenAttrs, ...writtenChildren] = right
    if (tag !== right[0]) return `<${String(tag)}>`
    if (stableJson(attrs) !== stableJson(writtenAttrs)) {
      const id = isRecord(attrs) ? attrs.id : undefined
      if (/^h[1-6]$/.test(String(tag)) && String(id) === id) return `heading ids such as {#${id}}`
      return `attributes on <${String(tag)}>`
    }
    return firstChange(children, writtenChildren, String(tag))
  }
}

/** What the editor would change in a body: constructs it drops, or the first construct whose shape changes. */
export interface ContentMarkdownLoss {
  /** Element tags that the written Markdown no longer has, such as `callout` or `kbd`. */
  lost: string[]
  /** Each lost or changed construct in words, such as `task lists` or `heading ids such as {#intro}`. */
  constructs: string[]
}

/**
 * Compares the Comark tree of a body as stored with the tree of what an editor writes for it. Formatting choices, such
 * as `*` or `-` bullets, key order in attributes, a reference link written inline, and a component prop written with
 * its declared default, parse the same and do not count. Returns undefined when nothing is lost.
 */
export function contentMarkdownLoss(stored: readonly unknown[], written: readonly unknown[], collection: ContentEditorCollection = {}): ContentMarkdownLoss | undefined {
  const components = collection.components ?? {}
  const before = normalizeNodes(stored, components)
  const after = normalizeNodes(written, components)
  if (stableJson(before) === stableJson(after)) return undefined
  const kept = new Map<string, { block: boolean, empty: boolean }>()
  collectTags(after, kept)
  const all = new Map<string, { block: boolean, empty: boolean }>()
  collectTags(before, all)
  const lost = [...all.keys()].filter(tag => !kept.has(tag))
  const constructs = [...new Set(lost.map(tag => describeTag(tag, all.get(tag)!)))]
  if (!constructs.length) constructs.push(firstChange(before, after, undefined) ?? "the block structure")
  return { lost, constructs }
}

/** Parses both Markdown texts the way the editor does, then compares them with `contentMarkdownLoss()`. */
export async function contentMarkdownLossOf(stored: string, written: string, collection: ContentEditorCollection = {}): Promise<ContentMarkdownLoss | undefined> {
  if (stored === written) return undefined
  const [before, after] = await Promise.all([parseMarkdown(stored, parseOptions), parseMarkdown(written, parseOptions)])
  const loss = contentMarkdownLoss(before.nodes, after.nodes, collection)
  // A body that starts with a YAML block reads as frontmatter, which the editor does not keep.
  if (stableJson(before.frontmatter ?? {}) === stableJson(after.frontmatter ?? {})) return loss
  return { lost: loss?.lost ?? [], constructs: ["a frontmatter block at the start of the body", ...loss?.constructs ?? []] }
}

/** One sentence that names what the editor cannot keep, for a read-only notice. */
export function describeContentMarkdownLoss(loss: ContentMarkdownLoss): string {
  const list = loss.constructs.length > 1 ? `${loss.constructs.slice(0, -1).join(", ")} and ${loss.constructs.at(-1)}` : loss.constructs[0]
  return `The editor cannot keep ${list}. Edit this body in Source.`
}

function keepFinalNewline(written: string, stored: string): string {
  return stored.endsWith("\n") && !written.endsWith("\n") ? `${written}\n` : written
}

/**
 * The Markdown codec of a Content collection for Realtime, built with comark-tiptap without an editor view or a DOM.
 * It runs on Node and on Cloudflare Workers. `verify()` opens a body that the editor would change as read-only and
 * names the construct; a body that only changes form comes back as `canonical`, so opening it writes nothing.
 * The Console builds its editor from `contentEditorComponents()` and `contentEditorKitOptions`, so both schemas match.
 */
export function contentRealtimeEditor(collection: ContentEditorCollection): RealtimeEditor {
  const components = contentEditorComponents(collection.components)
  const extensions = (): AnyExtension[] => [ComarkKit.configure({ components, ...contentEditorKitOptions, serializer: { injectStyles: false } })]
  let helpers: ComarkHelpers | undefined
  const codec = () => helpers ??= createSerializer({ nodes: [...comarkSpecs.nodes, ...components.map(component => component.spec)], marks: comarkSpecs.marks })
  let schema: ReturnType<typeof getSchema> | undefined

  async function fromMarkdown(markdown: string): Promise<JSONContent> {
    const tree = await parseMarkdown(markdown, parseOptions)
    // comark-tiptap leaves out nodes the schema does not have, such as undeclared components; verify() reports them.
    const document = comarkToPmDoc(tree, codec())
    schema ??= getSchema(extensions())
    // An empty body still needs one block. Normalizing through the schema also merges adjacent text.
    return schema.nodeFromJSON(document.content?.length ? document : { type: "doc", content: [{ type: "paragraph" }] }).toJSON()
  }

  async function toMarkdown(document: JSONContent): Promise<string> {
    return await renderMarkdown(pmDocToComark(document, codec()))
  }

  return {
    extensions,
    fromMarkdown,
    toMarkdown,
    async verify(markdown): Promise<RealtimeVerifyResult> {
      const written = keepFinalNewline(await toMarkdown(await fromMarkdown(markdown)), markdown)
      if (written === markdown) return { writable: true }
      const loss = await contentMarkdownLossOf(markdown, written, collection)
      if (loss) return { writable: false, issues: [{ field: "body", message: describeContentMarkdownLoss(loss), path: ["body"] }] }
      return { canonical: written, writable: true }
    },
  }
}
