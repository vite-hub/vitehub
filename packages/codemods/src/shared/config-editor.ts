import { detectStyle, end, findProperty, indentAt, isReference, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"

import { CodemodError } from "../types.ts"
import { findModuleEntry, literalValue, nitroPreset, staticOptionsObject, unwrapExpression } from "./nuxt-config.ts"

import type { ObjectExpression, ObjectProperty, Statement } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { LiteralValue, NuxtConfigFile } from "./nuxt-config.ts"

export const vitehubModule = "vite-hub/nuxt"

export const nitroPresetHosts: Record<string, string> = {
  "cloudflare-module": "cloudflare",
  "cloudflare": "cloudflare",
  "deno-deploy": "deno",
  "deno": "deno",
  "netlify": "netlify",
  "node-server": "node",
  "node": "node",
  "vercel": "vercel",
}

export function literal(value: LiteralValue, style: CodeStyle): string {
  return typeof value === "string" ? quoteString(value, style) : String(value)
}

export function propertyKey(name: string, style: CodeStyle): string {
  if (name === "__proto__") return `[${quoteString(name, style)}]`
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quoteString(name, style)
}

/** Top-level names that the program declares or imports. */
function topLevelNames(statements: readonly Statement[]): Set<string> {
  const names = new Set<string>()
  for (const statement of statements) {
    if (statement.type === "ImportDeclaration") for (const specifier of statement.specifiers) names.add(specifier.local.name)
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) if (declarator.id.type === "Identifier") names.add(declarator.id.name)
    }
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id) names.add(declaration.id.name)
  }
  return names
}

export function inRanges(position: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([from, to]) => position >= from && position < to)
}

/** Edits one nuxt.config file. Keeps the ranges it removed so later edits can skip them. */
export class ConfigEditor {
  readonly output: MagicString
  readonly style: CodeStyle
  readonly removed: Array<[number, number]> = []
  readonly removedImports: string[] = []
  private readonly code: string

  constructor(private readonly config: NuxtConfigFile) {
    this.code = config.code
    this.output = new MagicString(config.code)
    this.style = detectStyle(config.code, config.program)
  }

  removeItem(node: Node): void {
    const range = listItemRemoval(this.code, node)
    this.output.remove(range[0], range[1])
    this.removed.push(range)
  }

  /** Removes migrated `runtimeConfig` keys. Returns true when every key of `object` goes. */
  pruneRuntimeConfig(object: ObjectExpression, prefix: string[], migrated: ReadonlySet<string>, removals: Node[]): boolean {
    let removedCount = 0
    const local: Node[] = []
    for (const property of object.properties) {
      if (property.type !== "ObjectProperty") continue
      const key = keyName(property.key, property.computed)
      if (!key) continue
      const path = [...prefix, key]
      const value = property.value
      if (value.type === "ObjectExpression" && value.properties.length) {
        const childRemovals: Node[] = []
        if (this.pruneRuntimeConfig(value, path, migrated, childRemovals)) {
          local.push(property)
          removedCount++
        }
        else {
          local.push(...childRemovals)
        }
      }
      else if (migrated.has(path.join("."))) {
        local.push(property)
        removedCount++
      }
    }
    if (object.properties.length && removedCount === object.properties.length) return true
    removals.push(...local)
    return false
  }

  /** Inserts properties before the closing brace of `object`, after its last kept property. */
  /** Indentation of the properties of `object`. A one-line object gets the indentation it would have on several lines. */
  propertyIndent(object: ObjectExpression): string {
    const firstProperty = object.properties[0]
    if (firstProperty && this.code.slice(start(object), start(firstProperty)).includes("\n")) return indentAt(this.code, start(firstProperty))
    return `${indentAt(this.code, start(object))}${this.style.indent}`
  }

  insertProperties(object: ObjectExpression, entries: string[], removedProperties: ReadonlySet<Node>): void {
    const kept = object.properties.filter(property => !removedProperties.has(property))
    const last = kept.at(-1)
    const closing = end(object) - 1
    // A one-line object such as `{ host: 'node' }` goes on several lines, so the new entries can span lines.
    if (last && kept.length === object.properties.length && !this.code.slice(start(object), end(object)).includes("\n")) {
      const indent = this.propertyIndent(object)
      this.output.overwrite(start(object) + 1, start(kept[0]!), `\n${indent}`)
      kept.slice(1).forEach((property, index) => this.output.overwrite(end(kept[index]!), start(property), `,\n${indent}`))
      this.output.overwrite(end(last), closing, `,\n${entries.map(entry => `${indent}${entry},\n`).join("")}${indentAt(this.code, start(object))}`)
      return
    }
    const firstProperty = object.properties[0]
    const indent = firstProperty ? indentAt(this.code, start(firstProperty)) : `${indentAt(this.code, start(object))}${this.style.indent}`
    const closingIndent = indentAt(this.code, closing)
    const text = entries.map(entry => `${indent}${entry},\n`).join("")
    if (last && !/,/.test(this.output.slice(end(last), closing))) this.output.appendLeft(end(last), ",")
    const lineStart = this.code.lastIndexOf("\n", closing - 1) + 1
    const closingOnOwnLine = /^[ \t]*$/.test(this.code.slice(lineStart, closing))
    if (closingOnOwnLine && object.properties.length) this.output.prependRight(lineStart, text)
    else this.output.prependRight(closing, `\n${text}${closingIndent}`)
  }

  addImport(text: string): void {
    const body = this.config.program.program.body
    const kept = body.filter(statement => !inRanges(start(statement), this.removed))
    const lastImport = kept.filter(statement => statement.type === "ImportDeclaration").at(-1)
    if (lastImport) {
      this.output.appendLeft(end(lastImport), `\n${text}`)
      return
    }
    const first = kept[0]
    if (!first) {
      this.output.append(`\n${text}\n`)
      return
    }
    const from = Math.min(start(first), ...(first.leadingComments ?? []).map(comment => comment.start ?? start(first)))
    this.output.prependRight(from, `${text}\n\n`)
  }

  /** Removes imports and top-level constants that only the removed code used. */
  removeUnusedBindings(): void {
    const statements = this.config.program.program.body
    const declared = topLevelNames(statements)
    for (let changed = true; changed;) {
      changed = false
      const references = new Map<string, number>()
      const usedInRemoved = new Set<string>()
      walk(this.config.program, (node, ancestors) => {
        if (!isReference(node, ancestors.at(-1))) return
        if (inRanges(start(node), this.removed)) usedInRemoved.add(node.name)
        else references.set(node.name, (references.get(node.name) ?? 0) + 1)
      })
      for (const statement of statements) {
        if (inRanges(start(statement), this.removed)) continue
        if (statement.type === "ImportDeclaration") {
          if (!statement.specifiers.length) continue
          const unused = statement.specifiers.filter(specifier => usedInRemoved.has(specifier.local.name) && !references.get(specifier.local.name))
          if (!unused.length) continue
          if (unused.length === statement.specifiers.length) {
            this.removeStatement(statement)
            this.removedImports.push(statement.source.value)
          }
          else {
            for (const specifier of unused) this.removeItem(specifier)
          }
          changed = true
        }
        else if (statement.type === "VariableDeclaration" && statement.declarations.length === 1) {
          const id = statement.declarations[0]?.id
          if (id?.type !== "Identifier" || !declared.has(id.name)) continue
          // The declaration itself references nothing outside it, so count only other references.
          if (usedInRemoved.has(id.name) && !references.get(id.name)) {
            this.removeStatement(statement)
            changed = true
          }
        }
      }
    }
  }

  /** Removes a top-level statement with its leading comments and line break. */
  removeStatement(statement: Statement): void {
    const from = Math.min(start(statement), ...(statement.leadingComments ?? []).map(comment => comment.start ?? start(statement)))
    let to = end(statement)
    while (to < this.code.length && /[ \t]/.test(this.code[to] ?? "")) to++
    if (this.code[to] === "\n") to++
    if (this.code[to] === "\n" && (from === 0 || this.code[from - 1] === "\n")) to++
    this.output.remove(from, to)
    this.removed.push([from, to])
  }
}

/** True when no binding named `name` exists and no code reads one. Property names do not count. */
export function bindingFree(config: NuxtConfigFile, name: string): boolean {
  let used = false
  walk(config.program, (node, ancestors) => {
    if (node.type !== "Identifier" || node.name !== name) return
    const parent = ancestors.at(-1)
    if (isReference(node, parent) || (parent && (parent.type === "VariableDeclarator" || parent.type === "ImportSpecifier"
      || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier" || parent.type === "FunctionDeclaration"
      || parent.type === "ClassDeclaration"))) {
      used = true
    }
  })
  return !used
}

export function findViteHubEntry(config: NuxtConfigFile): Node | undefined {
  const modules = objectPropertyArray(config.root, "modules")
  const viteHubImports = new Set(config.program.program.body.flatMap(statement => statement.type === "ImportDeclaration" && statement.source.value === vitehubModule
    ? statement.specifiers.map(specifier => specifier.local.name)
    : []))
  for (const element of modules?.elements ?? []) {
    if (!element) continue
    const entry = unwrapExpression(element)
    const first = entry.type === "ArrayExpression" ? entry.elements[0] : entry
    if (!first) continue
    const head = unwrapExpression(first)
    if (literalValue(head) === vitehubModule || (head.type === "Identifier" && viteHubImports.has(head.name))) return entry
  }
  return undefined
}

export function objectPropertyArray(object: ObjectExpression, name: string) {
  const property = findProperty(object, name)
  const value = property ? unwrapExpression(property.value) : undefined
  return value?.type === "ArrayExpression" ? value : undefined
}

/** Reads an explicit ViteHub option. Rejects opaque objects; inline options take precedence over `vitehub`. */
export function findViteHubOption(config: NuxtConfigFile, name: string): ObjectProperty | undefined {
  const entry = findViteHubEntry(config)
  const inline = entry?.type === "ArrayExpression" ? entry.elements[1] : undefined
  const inlineOptions = inline ? staticOptionsObject(inline) : undefined
  if (inline && !inlineOptions) throw new CodemodError(`${config.fileName} sets inline vite-hub/nuxt options that cannot be read completely. Use an object literal with explicit, unique property names, then run the codemod again.`)
  const existing = findProperty(config.root, "vitehub")
  const rootOptions = existing ? staticOptionsObject(existing.value) : undefined
  if (existing && !rootOptions) throw new CodemodError(`${config.fileName} sets vitehub options that cannot be read completely. Use an object literal with explicit, unique property names, then run the codemod again.`)
  return (inlineOptions ? findProperty(inlineOptions, name) : undefined)
    ?? (rootOptions ? findProperty(rootOptions, name) : undefined)
}

/** Returns the line of the property at `path` from the config root in `code`, or of its nearest parent. */
export type LineResolver = (path: readonly string[], options?: { exact?: boolean }) => number | undefined

export function createLineResolver(code: string): LineResolver {
  let program: ReturnType<typeof parseProgram> | undefined
  try {
    program = parseProgram(code)
  }
  catch {
    return () => undefined
  }
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  let root: Node | undefined = exported?.declaration
  if (root?.type === "CallExpression") root = root.arguments[0]
  const rootObject = root?.type === "ObjectExpression" ? root : undefined
  const at = (object: ObjectExpression | undefined, path: readonly string[]): ObjectProperty | undefined => {
    let current = object
    let property: ObjectProperty | undefined
    for (const segment of path) {
      property = current ? findProperty(current, segment) : undefined
      current = property?.value.type === "ObjectExpression" ? property.value : undefined
      if (!property) return undefined
    }
    return property
  }
  return (path, options) => {
    for (let length = path.length; length > (options?.exact ? path.length - 1 : 0); length--) {
      const property = rootObject ? at(rootObject, path.slice(0, length)) : undefined
      if (property) return line(property)
    }
    return undefined
  }
}

function explicitModules(config: NuxtConfigFile) {
  const modules = objectPropertyArray(config.root, "modules")
  if (modules) return modules
  if (findProperty(config.root, "modules")) {
    throw new CodemodError(`${config.fileName} sets modules to an expression. Make it an array literal, then run the codemod again.`)
  }
  if (config.root.properties.some(property => property.type === "SpreadElement")) {
    throw new CodemodError(`${config.fileName} has a root spread that may supply modules. Make modules an explicit array literal, then run the codemod again.`)
  }
  return undefined
}

/**
 * Puts `vite-hub/nuxt` in `modules`. When `replace` names a module, its entry becomes `vite-hub/nuxt`, or goes
 * away when `vite-hub/nuxt` is already listed. Returns root properties to add, such as a new `modules` array.
 */
export function useViteHubModule(editor: ConfigEditor, config: NuxtConfigFile, replace?: string): string[] {
  const moduleEntry = replace ? findModuleEntry(config, replace) : undefined
  const existingViteHub = findViteHubEntry(config)
  const moduleText = quoteString(vitehubModule, editor.style)
  if (moduleEntry) {
    if (existingViteHub) editor.removeItem(moduleEntry.element)
    else {
      editor.output.overwrite(start(moduleEntry.element), end(moduleEntry.element), moduleText)
      editor.removed.push([start(moduleEntry.element), end(moduleEntry.element)])
    }
    return []
  }
  if (existingViteHub) return []
  const modules = explicitModules(config)
  if (modules) {
    const last = modules.elements.at(-1)
    if (last) editor.output.appendLeft(end(last), `, ${moduleText}`)
    else editor.output.appendLeft(end(modules) - 1, moduleText)
    return []
  }
  return [`modules: [${moduleText}]`]
}

export const nodeHostNote = `ViteHub needs a host, so the codemod set vitehub.host to "node". Change it to "cloudflare", "deno", "netlify", or "vercel" for other hosts.`

/** The host to add when nuxt.config sets none, instead of "node". */
export interface DefaultHost {
  host: string
  /** A follow-up about the choice, if any. */
  note?: string
}

/** One property that a codemod adds under `vitehub`. */
export interface ViteHubOption {
  key: string
  /** Renders the value. `indent` is the indentation of the `key` line. */
  value: (indent: string) => string
  /** Names what the option holds, for the error when `vitehub` already sets `key`, such as "the Env declarations". */
  label: string
}

export interface ViteHubOptionsResult {
  /** ViteHub host that the codemod set, if any. */
  host?: string
  hostNote?: string
}

/** The ViteHub host an app builds for, and the host that `addViteHubOptions()` adds when the app sets none. */
export interface HostPlan {
  /** The host the app will build for, when the codemod can tell. */
  host?: string
  /** The host to add under `vitehub`. */
  add?: string
  note?: string
}

export function planHost(config: NuxtConfigFile, defaultHost?: DefaultHost): HostPlan {
  const existingHost = findViteHubOption(config, "host")
  if (existingHost) {
    const value = literalValue(existingHost.value)
    return { host: typeof value === "string" ? value : undefined }
  }
  const preset = nitroPreset(config)
  if (preset.property && preset.value === undefined) {
    throw new CodemodError(`${config.fileName} sets nitro.preset to an expression. Make it a string literal or set an explicit vitehub.host, then run the codemod again.`)
  }
  if (preset.value) {
    const mapped = nitroPresetHosts[preset.value.trim().toLowerCase().replaceAll("_", "-")]
    return mapped
      ? { host: mapped, add: mapped }
      : { note: `nitro.preset "${preset.value}" has no ViteHub host. Set vitehub.host to "cloudflare", "deno", "netlify", "node", or "vercel" and remove nitro.preset.` }
  }
  return defaultHost
    ? { host: defaultHost.host, add: defaultHost.host, note: defaultHost.note }
    : { host: "node", add: "node", note: nodeHostNote }
}

/**
 * Adds `options` under `vitehub`, and a host when the app has none. Then inserts `rootEntries`
 * after the last root property that `removedRootProperties` does not hold.
 */
export function addViteHubOptions(editor: ConfigEditor, config: NuxtConfigFile, input: { options: readonly ViteHubOption[], rootEntries: readonly string[], removedRootProperties: ReadonlySet<Node>, defaultHost?: DefaultHost }): ViteHubOptionsResult {
  const style = editor.style
  const rootEntries = [...input.rootEntries]
  const existingOptions = findProperty(config.root, "vitehub")
  const planned = planHost(config, input.defaultHost)
  let vitehubHost = planned.add
  let hostNote = planned.note
  const unit = style.indent
  const baseIndent = config.root.properties[0] ? indentAt(config.code, start(config.root.properties[0])) : unit
  if (existingOptions) {
    if (existingOptions.value.type !== "ObjectExpression") throw new CodemodError(`${config.fileName} sets vitehub to an expression. Make it an object literal, then run the codemod again.`)
    const existing = existingOptions.value
    for (const option of input.options) {
      if (findProperty(existing, option.key)) throw new CodemodError(`${config.fileName} already sets vitehub.${option.key}. Merge ${option.label} by hand.`)
    }
    const innerIndent = existing.properties.length ? editor.propertyIndent(existing) : `${baseIndent}${unit}`
    const entries = input.options.map(option => `${option.key}: ${option.value(innerIndent)}`)
    if (vitehubHost && !findProperty(existing, "host")) entries.unshift(`host: ${quoteString(vitehubHost, style)}`)
    else if (findProperty(existing, "host")) {
      vitehubHost = undefined
      hostNote = undefined
    }
    editor.insertProperties(existing, entries, new Set())
  }
  else {
    const innerIndent = `${baseIndent}${unit}`
    const entries = [
      ...(vitehubHost ? [`${innerIndent}host: ${quoteString(vitehubHost, style)},`] : []),
      ...input.options.map(option => `${innerIndent}${option.key}: ${option.value(innerIndent)},`),
    ]
    rootEntries.push(`vitehub: {\n${entries.join("\n")}\n${baseIndent}}`)
  }
  if (rootEntries.length) editor.insertProperties(config.root, rootEntries, input.removedRootProperties)
  return { host: vitehubHost, hostNote }
}

/** Removes the `modules` entry of `moduleName`. Returns false when `modules` does not list it. */
export function removeModuleEntry(editor: ConfigEditor, config: NuxtConfigFile, moduleName: string): boolean {
  const entry = findModuleEntry(config, moduleName)
  if (!entry) {
    explicitModules(config)
    return false
  }
  editor.removeItem(entry.element)
  return true
}
