import { join } from "node:path"

import { end, findProperty, keyName, line, start } from "@vite-hub/internal/ast"
import { createJiti } from "jiti"

import { defaultExport, literalValue, objectProperty, unwrapExpression } from "../shared/nuxt-config.ts"
import { CodemodError } from "../types.ts"

import type { Node, ObjectExpression, ObjectProperty } from "@babel/types"
import type { LiteralValue, NuxtConfigFile } from "../shared/nuxt-config.ts"

export const moduleName = "nuxt-safe-runtime-config"

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
