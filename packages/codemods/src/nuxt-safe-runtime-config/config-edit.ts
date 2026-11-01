import MagicString from "magic-string"

import { detectStyle, end, findProperty, indentAt, isReference, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "../ast.ts"
import { CodemodError } from "../types.ts"
import { findModuleEntry, literalValue, nitroPreset, objectProperty } from "./nuxt-config.ts"

import type { ObjectExpression, ObjectProperty, Statement } from "@babel/types"
import type { CodeStyle, Node } from "../ast.ts"
import type { EnvField, LiteralValue } from "./fields.ts"
import type { NuxtConfigFile } from "./nuxt-config.ts"

export type EnvSource =
  | { kind: "fields", fields: readonly EnvField[] }
  | { kind: "env-schema", file: string, paths: Record<string, string> }

export interface ConfigEditInput {
  config: NuxtConfigFile
  env: EnvSource
  /** `runtimeConfig` labels to remove, such as `apiSecret` or `public.apiBase`. */
  migrated: ReadonlySet<string>
}

export interface ConfigEditResult {
  code: string
  /** ViteHub deployment preset that the codemod set, if any. */
  preset?: string
  presetNote?: string
  imports: string[]
  /** Sources of the imports that only the removed code used, such as `valibot`. */
  removedImports: string[]
  /** Line of the property at `path` from the config root in the new code, or of its nearest parent. */
  lineOf: (path: readonly string[], options?: { exact?: boolean }) => number | undefined
}

const vitehubModule = "vite-hub/nuxt"

const nitroPresets: Record<string, string> = {
  "cloudflare-module": "cloudflare",
  "cloudflare": "cloudflare",
  "deno-deploy": "deno",
  "deno": "deno",
  "netlify": "netlify",
  "node-server": "node",
  "node": "node",
  "vercel": "vercel",
}

function literal(value: LiteralValue, style: CodeStyle): string {
  return typeof value === "string" ? quoteString(value, style) : String(value)
}

function propertyKey(name: string, style: CodeStyle): string {
  if (name === "__proto__") return `[${quoteString(name, style)}]`
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quoteString(name, style)
}

export function declarationCode(field: EnvField, envName: string, style: CodeStyle): string {
  const options: string[] = []
  if (field.default !== undefined) options.push(`default: ${literal(field.default, style)}`)
  if (field.section === "public") options.push(`mode: ${quoteString("build", style)}`)
  if (!field.required) options.push("required: false")
  if (field.secret) options.push("secret: true")
  const names = [field.variable, ...(field.extraVariables ?? [])]
  const source = names.length === 1 ? quoteString(field.variable, style) : `[${names.map(name => quoteString(name, style)).join(", ")}]`
  options.push(`source: ${envName}.source(${source})`)
  const callee = field.kind === "string" ? envName : `${envName}.${field.kind}`
  const values = field.kind === "enum" ? `[${(field.values ?? []).map(value => quoteString(value, style)).join(", ")}], ` : ""
  return `${callee}(${values}{ ${options.join(", ")} })`
}

type Tree = Map<string, Tree | string>

function sectionTree(fields: readonly EnvField[], envName: string, style: CodeStyle): Tree {
  const tree: Tree = new Map()
  for (const field of fields) {
    let node = tree
    field.envPath.forEach((segment, index) => {
      if (index === field.envPath.length - 1) {
        node.set(segment, declarationCode(field, envName, style))
        return
      }
      const child = node.get(segment)
      const next: Tree = child instanceof Map ? child : new Map()
      node.set(segment, next)
      node = next
    })
  }
  return tree
}

function renderTree(tree: Tree, indent: string, unit: string, style: CodeStyle): string {
  const lines = [...tree].map(([key, value]) => typeof value === "string"
    ? `${indent}${unit}${propertyKey(key, style)}: ${value},`
    : `${indent}${unit}${propertyKey(key, style)}: ${renderTree(value, `${indent}${unit}`, unit, style)},`)
  return `{\n${lines.join("\n")}\n${indent}}`
}

function envExpression(env: EnvSource, envName: string, indent: string, style: CodeStyle): string {
  if (env.kind === "env-schema") {
    const file = /^\.\.?\//.test(env.file) ? env.file : `./${env.file}`
    const options = [`prefix: ${quoteString("NUXT_", style)}`]
    const paths = Object.entries(env.paths)
    if (paths.length) options.push(`paths: { ${paths.map(([key, value]) => `${propertyKey(key, style)}: ${quoteString(value, style)}`).join(", ")} }`)
    return `envSchema(new URL(${quoteString(file, style)}, import.meta.url), { ${options.join(", ")} })`
  }
  const sections: Tree = new Map()
  const publicFields = env.fields.filter(field => field.section === "public")
  const serverFields = env.fields.filter(field => field.section === "server")
  if (publicFields.length) sections.set("public", sectionTree(publicFields, envName, style))
  if (serverFields.length) sections.set("server", sectionTree(serverFields, envName, style))
  return renderTree(sections, indent, style.indent, style)
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

function inRanges(position: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([from, to]) => position >= from && position < to)
}

class ConfigEditor {
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
  insertProperties(object: ObjectExpression, entries: string[], removedProperties: ReadonlySet<Node>): void {
    const kept = object.properties.filter(property => !removedProperties.has(property))
    const last = kept.at(-1)
    const closing = end(object) - 1
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

  private removeStatement(statement: Statement): void {
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
function bindingFree(config: NuxtConfigFile, name: string): boolean {
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

function findViteHubEntry(config: NuxtConfigFile): Node | undefined {
  const modules = objectPropertyArray(config.root, "modules")
  const viteHubImports = new Set(config.program.program.body.flatMap(statement => statement.type === "ImportDeclaration" && statement.source.value === vitehubModule
    ? statement.specifiers.map(specifier => specifier.local.name)
    : []))
  return modules?.elements.find((element) => {
    if (!element) return false
    const head = element.type === "ArrayExpression" ? element.elements[0] : element
    if (!head) return false
    return literalValue(head) === vitehubModule || (head.type === "Identifier" && viteHubImports.has(head.name))
  }) ?? undefined
}

function objectPropertyArray(object: ObjectExpression, name: string) {
  const property = findProperty(object, name)
  return property?.value.type === "ArrayExpression" ? property.value : undefined
}

function hasInlinePreset(entry: Node | undefined): boolean {
  if (entry?.type !== "ArrayExpression") return false
  const options = entry.elements[1]
  return options?.type === "ObjectExpression" && Boolean(findProperty(options, "preset"))
}

/** Edits nuxt.config: swaps the module, removes `safeRuntimeConfig` and migrated keys, and adds `vitehub.env`. */
export function editNuxtConfig(input: ConfigEditInput): ConfigEditResult {
  const { config } = input
  const editor = new ConfigEditor(config)
  const style = editor.style
  const removedRootProperties = new Set<Node>()

  const moduleEntry = findModuleEntry(config)
  const existingViteHub = findViteHubEntry(config)
  const moduleText = quoteString(vitehubModule, style)
  const rootEntries: string[] = []
  if (moduleEntry) {
    if (existingViteHub) editor.removeItem(moduleEntry.element)
    else {
      editor.output.overwrite(start(moduleEntry.element), end(moduleEntry.element), moduleText)
      editor.removed.push([start(moduleEntry.element), end(moduleEntry.element)])
    }
  }
  else if (!existingViteHub) {
    const modules = objectPropertyArray(config.root, "modules")
    if (modules) {
      const last = modules.elements.at(-1)
      if (last) editor.output.appendLeft(end(last), `, ${moduleText}`)
      else editor.output.appendLeft(end(modules) - 1, moduleText)
    }
    else if (findProperty(config.root, "modules")) {
      throw new CodemodError(`${config.fileName} sets modules to an expression. Make it an array literal, then run the codemod again.`)
    }
    else if (config.root.properties.some(property => property.type === "SpreadElement")) {
      throw new CodemodError(`${config.fileName} has a root spread that may supply modules. Make modules an explicit array literal, then run the codemod again.`)
    }
    else {
      rootEntries.push(`modules: [${moduleText}]`)
    }
  }

  const safeOptions = findProperty(config.root, "safeRuntimeConfig")
  if (safeOptions) {
    editor.removeItem(safeOptions)
    removedRootProperties.add(safeOptions)
  }

  const runtimeConfig = objectProperty(config.root, "runtimeConfig")
  const runtimeProperty = findProperty(config.root, "runtimeConfig")
  if (runtimeConfig && runtimeProperty) {
    const removals: Node[] = []
    if (editor.pruneRuntimeConfig(runtimeConfig, [], input.migrated, removals)) {
      editor.removeItem(runtimeProperty)
      removedRootProperties.add(runtimeProperty)
    }
    else {
      for (const removal of removals) editor.removeItem(removal)
    }
  }

  let envName = "env"
  const imports: string[] = []
  const semicolon = style.semicolons ? ";" : ""
  if (input.env.kind === "fields") {
    if (!bindingFree(config, "env")) envName = "viteHubEnv"
    const specifier = envName === "env" ? "env" : `env as ${envName}`
    imports.push(`import { ${specifier} } from ${quoteString("vite-hub/env", style)}${semicolon}`)
  }
  else {
    if (!bindingFree(config, "envSchema")) throw new CodemodError(`${config.fileName} already declares envSchema. Rename it, then run the codemod again.`)
    imports.push(`import { envSchema } from ${quoteString("@vite-hub/env/vite", style)}${semicolon}`)
  }

  const existingOptions = findProperty(config.root, "vitehub")
  const existingPreset = existingOptions?.value.type === "ObjectExpression" ? findProperty(existingOptions.value, "preset") : undefined
  const inlinePreset = hasInlinePreset(existingViteHub)
  const preset = nitroPreset(config)
  if (preset.property && preset.value === undefined && !inlinePreset && !existingPreset) {
    throw new CodemodError(`${config.fileName} sets nitro.preset to an expression. Make it a string literal or set an explicit vitehub.preset, then run the codemod again.`)
  }
  let vitehubPreset: string | undefined = "node"
  let presetNote: string | undefined = `ViteHub needs a deployment preset, so the codemod set vitehub.preset to "node". Change it to "cloudflare", "deno", "netlify", or "vercel" for other hosts.`
  if (preset.value) {
    vitehubPreset = nitroPresets[preset.value.trim().toLowerCase().replaceAll("_", "-")]
    presetNote = vitehubPreset
      ? undefined
      : `nitro.preset "${preset.value}" has no ViteHub deployment preset. Set vitehub.preset to "cloudflare", "deno", "netlify", "node", or "vercel" and remove nitro.preset.`
  }
  if (inlinePreset) {
    vitehubPreset = undefined
    presetNote = undefined
  }

  const unit = style.indent
  const baseIndent = config.root.properties[0] ? indentAt(config.code, start(config.root.properties[0])) : unit
  if (existingOptions) {
    if (existingOptions.value.type !== "ObjectExpression") throw new CodemodError(`${config.fileName} sets vitehub to an expression. Make it an object literal, then run the codemod again.`)
    if (findProperty(existingOptions.value, "env")) throw new CodemodError(`${config.fileName} already sets vitehub.env. Merge the Env declarations by hand.`)
    const innerIndent = existingOptions.value.properties[0] ? indentAt(config.code, start(existingOptions.value.properties[0])) : `${baseIndent}${unit}`
    const entries = [`env: ${envExpression(input.env, envName, innerIndent, style)}`]
    if (vitehubPreset && !findProperty(existingOptions.value, "preset")) entries.unshift(`preset: ${quoteString(vitehubPreset, style)}`)
    else if (findProperty(existingOptions.value, "preset")) presetNote = undefined
    editor.insertProperties(existingOptions.value, entries, new Set())
  }
  else {
    const innerIndent = `${baseIndent}${unit}`
    const entries = [
      ...(vitehubPreset ? [`${innerIndent}preset: ${quoteString(vitehubPreset, style)},`] : []),
      `${innerIndent}env: ${envExpression(input.env, envName, innerIndent, style)},`,
    ]
    rootEntries.push(`vitehub: {\n${entries.join("\n")}\n${baseIndent}}`)
  }
  if (rootEntries.length) editor.insertProperties(config.root, rootEntries, removedRootProperties)
  editor.removeUnusedBindings()
  for (const text of imports) editor.addImport(text)

  const code = editor.output.toString()
  return {
    code,
    preset: vitehubPreset,
    presetNote,
    imports: input.env.kind === "fields" ? ["vite-hub/env"] : ["@vite-hub/env/vite"],
    removedImports: editor.removedImports,
    lineOf: createLineResolver(code),
  }
}

function createLineResolver(code: string): ConfigEditResult["lineOf"] {
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
