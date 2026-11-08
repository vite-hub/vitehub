import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { findProperty, keyName, parseProgram, walk } from "@vite-hub/internal/ast"
import { createJiti } from "jiti"

import { CodemodError } from "../types.ts"

import type { ArrayExpression, Expression, File, Node, ObjectExpression, ObjectProperty } from "@babel/types"

/** A value that a codemod can read from source without running it. */
export type LiteralValue = boolean | number | string

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

export function unwrapExpression(node: Node): Node {
  let current = node
  while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression
  }
  return current
}

/** Reads an object with explicit, unique property names. Its values may still be expressions. */
export function staticOptionsObject(node: Node): ObjectExpression | undefined {
  const object = unwrapExpression(node)
  if (object.type !== "ObjectExpression") return undefined
  const keys = new Set<string>()
  for (const property of object.properties) {
    if (property.type !== "ObjectProperty") return undefined
    const key = keyName(property.key, property.computed)
    if (key === undefined || keys.has(key)) return undefined
    keys.add(key)
  }
  return object
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

/** The entry of a module in `modules`, as a string or as a `[name, options]` tuple. */
export interface ModuleEntry {
  modules: ArrayExpression
  element: Node
  inlineOptions?: Node
}

export function findModuleEntry(config: NuxtConfigFile, moduleName: string): ModuleEntry | undefined {
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

/** The default export of a module namespace, or the value itself. */
export function defaultExport(module: unknown): unknown {
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
