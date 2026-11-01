import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createJiti } from "jiti"

import { end, findProperty, keyName, line, parseProgram, start, walk } from "../ast.ts"
import { CodemodError } from "../types.ts"

import type { ArrayExpression, Expression, File, Node, ObjectExpression, ObjectProperty } from "@babel/types"
import type { LiteralValue } from "./fields.ts"

export const moduleName = "nuxt-safe-runtime-config"

const configNames = ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs"]

export interface NuxtConfigFile {
  path: string
  fileName: string
  code: string
  program: File
  /** The object passed to `defineNuxtConfig()` or exported by default. */
  root: ObjectExpression
}

export async function readNuxtConfig(cwd: string): Promise<NuxtConfigFile> {
  const fileName = configNames.find(name => existsSync(join(cwd, name)))
  if (!fileName) throw new CodemodError(`Cannot find nuxt.config in ${cwd}. Pass the Nuxt app directory as the first argument.`)
  const path = join(cwd, fileName)
  const code = await readFile(path, "utf8")
  let program: File
  try {
    program = parseProgram(code)
  }
  catch (error) {
    throw new CodemodError(`Cannot parse ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = findConfigObject(program)
  if (!root) throw new CodemodError(`${fileName} must export an object literal, for example \`export default defineNuxtConfig({ ... })\`.`)
  return { path, fileName, code, program, root }
}

function unwrapExpression(node: Node): Node {
  let current = node
  while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression
  }
  return current
}

function findConfigObject(program: File): ObjectExpression | undefined {
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  if (!exported) return undefined
  let value = unwrapExpression(exported.declaration)
  if (value.type === "Identifier") {
    const name = value.name
    for (const statement of program.program.body) {
      if (statement.type !== "VariableDeclaration") continue
      for (const declarator of statement.declarations) {
        if (declarator.id.type === "Identifier" && declarator.id.name === name && declarator.init) value = unwrapExpression(declarator.init)
      }
    }
  }
  if (value.type === "CallExpression") {
    const [argument] = value.arguments
    if (!argument) return undefined
    value = unwrapExpression(argument)
  }
  return value.type === "ObjectExpression" ? value : undefined
}

export function objectProperty(object: ObjectExpression, name: string): ObjectExpression | undefined {
  const property = findProperty(object, name)
  const value = property ? unwrapExpression(property.value) : undefined
  return value?.type === "ObjectExpression" ? value : undefined
}

export function literalValue(node: Node): LiteralValue | undefined {
  const value = unwrapExpression(node)
  if (value.type === "StringLiteral" || value.type === "NumericLiteral" || value.type === "BooleanLiteral") return value.value
  if (value.type === "TemplateLiteral" && !value.expressions.length) return value.quasis[0]?.value.cooked ?? undefined
  if (value.type === "UnaryExpression" && value.operator === "-" && value.argument.type === "NumericLiteral") return -value.argument.value
  return undefined
}

/** The module entry in `modules`, as a string or as a `[name, options]` tuple. */
export interface ModuleEntry {
  modules: ArrayExpression
  element: Node
  inlineOptions?: Node
}

export function findModuleEntry(config: NuxtConfigFile): ModuleEntry | undefined {
  const modulesProperty = findProperty(config.root, "modules")
  const modules = modulesProperty ? unwrapExpression(modulesProperty.value) : undefined
  if (modules?.type !== "ArrayExpression") return undefined
  for (const element of modules.elements) {
    if (!element) continue
    if (literalValue(element) === moduleName) return { modules, element }
    const tuple = unwrapExpression(element)
    if (tuple.type === "ArrayExpression" && tuple.elements[0] && literalValue(tuple.elements[0]) === moduleName) {
      return { modules, element, inlineOptions: tuple.elements[1] ?? undefined }
    }
  }
  return undefined
}

export interface StaticOptions {
  envSchema?: { file: string, paths: Record<string, string> }
  schemaPath?: string
  /** `$schema` is an inline expression; the evaluated config supplies it. */
  inlineSchema: boolean
  /** An option could not be read without running the config. */
  dynamic: boolean
}

function readStaticPaths(node: Node | undefined): Record<string, string> | undefined {
  if (!node) return {}
  const value = unwrapExpression(node)
  if (value.type !== "ObjectExpression") return undefined
  const paths: Record<string, string> = {}
  for (const property of value.properties) {
    if (property.type !== "ObjectProperty") return undefined
    const key = keyName(property.key, property.computed)
    const mapped = literalValue(property.value)
    if (!key || typeof mapped !== "string") return undefined
    paths[key] = mapped
  }
  return paths
}

/** Reads `envSchema` and `$schema` from one options object without running code. */
export function readStaticOptions(options: Node | undefined): StaticOptions {
  const result: StaticOptions = { inlineSchema: false, dynamic: false }
  if (!options) return result
  const object = unwrapExpression(options)
  if (object.type !== "ObjectExpression") return { ...result, dynamic: true }
  for (const property of object.properties) {
    if (property.type !== "ObjectProperty") {
      result.dynamic = true
      continue
    }
    const key = keyName(property.key, property.computed)
    if (key === "envSchema") {
      const literal = literalValue(property.value)
      const value = unwrapExpression(property.value)
      if (typeof literal === "string") {
        result.envSchema = { file: literal, paths: {} }
      }
      else if (value.type === "ObjectExpression") {
        const file = findProperty(value, "file")
        const fileName = file ? literalValue(file.value) : undefined
        const paths = readStaticPaths(findProperty(value, "paths")?.value)
        if (typeof fileName === "string" && paths) result.envSchema = { file: fileName, paths }
        else result.dynamic = true
      }
      else {
        result.dynamic = true
      }
    }
    if (key === "$schema") {
      const literal = literalValue(property.value)
      if (typeof literal === "string") result.schemaPath = literal
      else result.inlineSchema = true
    }
  }
  return result
}

/** A value in the `runtimeConfig` object literal. */
export interface RuntimeConfigValue {
  property: ObjectProperty
  literal?: LiteralValue
  /** `process.env.NAME`, optionally with a `||` or `??` literal fallback. */
  processEnv?: { name: string, fallback?: LiteralValue, operator?: "||" | "??" }
  /** Source text of a value the codemod cannot read statically. */
  expression?: string
  line: number
}

function processEnvName(node: Node): string | undefined {
  const value = unwrapExpression(node)
  if (value.type !== "MemberExpression") return undefined
  const object = value.object
  if (object.type !== "MemberExpression" || object.computed) return undefined
  if (object.object.type !== "Identifier" || object.object.name !== "process") return undefined
  if (keyName(object.property) !== "env") return undefined
  return keyName(value.property, value.computed)
}

export function readRuntimeConfigValue(code: string, property: ObjectProperty): RuntimeConfigValue {
  const node = unwrapExpression(property.value)
  const base = { property, line: line(property) }
  const literal = literalValue(node)
  if (literal !== undefined) return { ...base, literal }
  const envName = processEnvName(node)
  if (envName) return { ...base, processEnv: { name: envName } }
  if (node.type === "LogicalExpression" && (node.operator === "||" || node.operator === "??")) {
    const name = processEnvName(node.left)
    const fallback = literalValue(node.right)
    if (name && fallback !== undefined) return { ...base, processEnv: { name, fallback, operator: node.operator } }
  }
  return { ...base, expression: code.slice(start(node), end(node)) }
}

/** Lists `runtimeConfig` entries by path. Nested object literals become nested paths. */
export function readRuntimeConfig(config: NuxtConfigFile): { object?: ObjectExpression, values: Map<string, RuntimeConfigValue>, groups: Set<string> } {
  const object = objectProperty(config.root, "runtimeConfig")
  const values = new Map<string, RuntimeConfigValue>()
  const groups = new Set<string>()
  const visit = (node: ObjectExpression, path: string[]) => {
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty") continue
      const key = keyName(property.key, property.computed)
      if (!key) continue
      const value = unwrapExpression(property.value)
      if (value.type === "ObjectExpression") {
        groups.add([...path, key].join("."))
        visit(value, [...path, key])
      }
      else {
        values.set([...path, key].join("."), readRuntimeConfigValue(config.code, property))
      }
    }
  }
  if (object) visit(object, [])
  return { object, values, groups }
}

function defaultExport(module: unknown): unknown {
  return typeof module === "object" && module !== null && "default" in module ? module.default : module
}

/** Runs nuxt.config with a `defineNuxtConfig` stub and returns the exported object. */
export async function loadNuxtConfig(path: string): Promise<Record<string, unknown>> {
  const hadPrevious = Reflect.has(globalThis, "defineNuxtConfig")
  const previous: unknown = Reflect.get(globalThis, "defineNuxtConfig")
  Reflect.set(globalThis, "defineNuxtConfig", (config: unknown) => config)
  try {
    const jiti = createJiti(path, { moduleCache: false, fsCache: false, interopDefault: false })
    const loaded = defaultExport(await jiti.import(path))
    const value: unknown = typeof loaded === "function" ? await Reflect.apply(loaded, undefined, []) : loaded
    if (typeof value !== "object" || value === null) throw new CodemodError(`${path} did not export a config object.`)
    return Object.fromEntries(Object.entries(value))
  }
  catch (error) {
    if (error instanceof CodemodError) throw error
    throw new CodemodError(`Cannot load ${path} to read the $schema: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    if (hadPrevious) Reflect.set(globalThis, "defineNuxtConfig", previous)
    else Reflect.deleteProperty(globalThis, "defineNuxtConfig")
  }
}

/** Imports a module that default-exports a schema, resolved from the project directory. */
export async function loadSchemaModule(cwd: string, specifier: string): Promise<unknown> {
  try {
    // Default interop would return a Zod schema's `default` method instead of the schema.
    const jiti = createJiti(join(cwd, "codemod.loader.mjs"), { moduleCache: false, fsCache: false, interopDefault: false })
    return defaultExport(await jiti.import(jiti.esmResolve(specifier)))
  }
  catch (error) {
    throw new CodemodError(`Cannot load the $schema module ${specifier}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function nitroPreset(config: NuxtConfigFile): { value?: string, property?: ObjectProperty } {
  const nitro = objectProperty(config.root, "nitro")
  const property = nitro ? findProperty(nitro, "preset") : undefined
  const value = property ? literalValue(property.value) : undefined
  return { value: typeof value === "string" ? value : undefined, property }
}

/** Every identifier name in the source range of `node`. */
export function identifiersIn(node: Node): Set<string> {
  const names = new Set<string>()
  walk(node, (child) => {
    if (child.type === "Identifier") names.add(child.name)
  })
  return names
}

export function isExpression(node: Node): node is Expression {
  return node.type !== "SpreadElement" && node.type !== "ArgumentPlaceholder" && node.type !== "JSXNamespacedName"
}
