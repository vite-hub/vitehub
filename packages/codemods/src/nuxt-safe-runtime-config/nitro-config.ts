import { existsSync } from "node:fs"
import { join } from "node:path"

import { end, findProperty, indentAt, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"

import { codemodError, codemodsErrorDiagnostics } from "../error-diagnostics.ts"
import { bindingFree, ConfigEditor, createLineResolver, nitroPresetHosts } from "../shared/config-editor.ts"
import { readDependencies } from "../shared/detect.ts"
import { findNuxtConfigName, literalValue, objectProperty, readConfigFile, unwrapExpression } from "../shared/nuxt-config.ts"
import { envExpression } from "./config-edit.ts"

import type { ArrayExpression, ObjectExpression, ObjectProperty } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { LineResolver } from "../shared/config-editor.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { FileEdit } from "../types.ts"
import type { EnvSource, SchemaModuleReference } from "./config-edit.ts"
import type { EnvField } from "./fields.ts"

/** The module that registers nuxt-safe-runtime-config in a Nitro app without Nuxt. */
export const nitroModuleName = "nuxt-safe-runtime-config/nitro"

const configNames = ["nitro.config.ts", "nitro.config.mts", "nitro.config.js", "nitro.config.mjs", "nitro.config.cjs"]
const viteConfigNames = ["vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]

/** The file name of the project's nitro.config, or `undefined` when it has none. */
export function findNitroConfigName(cwd: string): string | undefined {
  return configNames.find(name => existsSync(join(cwd, name)))
}

/** Stops a Nitro app without a nuxt.config that runs on Nitro 2 (`nitropack`), before the codemod plans any edit. */
export async function assertNotNitro2(cwd: string, codemod: string): Promise<void> {
  if (findNuxtConfigName(cwd)) return
  const config = findNitroConfigName(cwd)
  if (!config) return
  const dependencies = await readDependencies(cwd)
  const nitropack = dependencies.get("nitropack")
  if (nitropack === undefined || dependencies.has("nitro")) return
  throw codemodsErrorDiagnostics.CODEMODS_NITRO_UNSUPPORTED({ codemod, config, nitropack })
}

/** True for a Nitro 3 app without Nuxt: it has a nitro.config, no nuxt.config, and the `nitro` package. */
export async function isNitroApp(cwd: string): Promise<boolean> {
  if (findNuxtConfigName(cwd) || !findNitroConfigName(cwd)) return false
  return (await readDependencies(cwd)).has("nitro")
}

export async function readNitroConfig(cwd: string): Promise<NuxtConfigFile> {
  const fileName = findNitroConfigName(cwd)
  if (!fileName) throw codemodError(`Cannot find nitro.config in ${cwd}. Pass the Nitro app directory as the first argument.`)
  return readConfigFile(cwd, fileName, "defineConfig")
}

/** The `modules` entry of the Nitro module, as its import binding or as its specifier. */
export interface NitroModuleEntry {
  modules: ArrayExpression
  element: Node
}

export function findNitroModuleEntry(config: NuxtConfigFile): NitroModuleEntry | undefined {
  const property = findProperty(config.root, "modules")
  const modules = property ? unwrapExpression(property.value) : undefined
  if (modules?.type !== "ArrayExpression") return undefined
  const bindings = new Set(config.program.program.body.flatMap(statement => statement.type === "ImportDeclaration" && statement.source.value === nitroModuleName
    ? statement.specifiers.map(specifier => specifier.local.name)
    : []))
  const isModule = (node: Node) => {
    const value = unwrapExpression(node)
    return literalValue(value) === nitroModuleName || (value.type === "Identifier" && bindings.has(value.name))
  }
  const element = modules.elements.find((entry): entry is NonNullable<typeof entry> => entry !== null && isModule(entry))
  return element ? { modules, element } : undefined
}

/**
 * The ViteHub host for the Nitro `preset`, and the `preset` property that `vitehub()` replaces: `preset` in nitro.config,
 * or `removeVitePreset` for a `preset` in the vite.config `nitro()` options, which win over nitro.config.
 */
export interface NitroHostPlan {
  host?: string
  note?: string
  preset?: ObjectProperty
  removeVitePreset?: boolean
}

function nitroPluginOptions(config: NuxtConfigFile): ObjectExpression[] {
  const local = importedLocal(config, "nitro/vite", "nitro")
  const options: ObjectExpression[] = []
  const nitroKey = objectProperty(config.root, "nitro")
  if (nitroKey) options.push(nitroKey)
  if (!local) return options
  walk(config.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== local) return
    const [argument] = node.arguments
    if (argument?.type === "ObjectExpression") options.push(argument)
  })
  return options
}

function vitePresetProperty(config: NuxtConfigFile): ObjectProperty | undefined {
  return nitroPluginOptions(config).map(options => findProperty(options, "preset")).find(property => property !== undefined)
}

export async function readVitePreset(cwd: string): Promise<{ fileName: string, property: ObjectProperty } | undefined> {
  const fileName = findViteConfigName(cwd)
  if (!fileName) return undefined
  const property = vitePresetProperty(await readConfigFile(cwd, fileName, "defineConfig"))
  return property ? { fileName, property } : undefined
}

export function planNitroHost(config: NuxtConfigFile, vitePreset?: { fileName: string, property: ObjectProperty }): NitroHostPlan {
  const property = vitePreset?.property ?? findProperty(config.root, "preset")
  const fileName = vitePreset?.fileName ?? config.fileName
  if (!property) {
    return { host: "node", note: "ViteHub needs a host, so the codemod set host: \"node\" in vitehub(). Change it to \"cloudflare\", \"deno\", \"netlify\", or \"vercel\" for other hosts." }
  }
  const value = literalValue(property.value)
  if (typeof value !== "string") throw codemodError(`${fileName} sets preset to an expression. Make it a string literal, then run the codemod again.`)
  const host = nitroPresetHosts[value.trim().toLowerCase().replaceAll("_", "-")]
  if (host) return vitePreset ? { host, removeVitePreset: true } : { host, preset: property }
  return { note: `preset "${value}" has no ViteHub host. ViteHub sets the Nitro preset from its host, and a different preset stops the build. Set host in vitehub() to "cloudflare", "deno", "netlify", "node", or "vercel", and remove preset from ${fileName}.` }
}

export interface NitroConfigEditResult {
  code: string
  /** Sources of the imports that only the removed code used. */
  removedImports: string[]
  lineOf: LineResolver
}

/** Removes the Nitro module, `safeRuntimeConfig`, the migrated `runtimeConfig` keys, and a `preset` that `vitehub()` replaces. */
export function editNitroConfig(input: { config: NuxtConfigFile, moduleEntry?: NitroModuleEntry, migrated: ReadonlySet<string>, preset?: ObjectProperty }): NitroConfigEditResult {
  const { config, moduleEntry } = input
  const editor = new ConfigEditor(config)
  if (moduleEntry) {
    const modulesProperty = findProperty(config.root, "modules")
    if (modulesProperty && moduleEntry.modules.elements.length === 1) editor.removeItem(modulesProperty)
    else editor.removeItem(moduleEntry.element)
  }
  const safeProperty = findProperty(config.root, "safeRuntimeConfig")
  if (safeProperty) editor.removeItem(safeProperty)
  if (input.preset) editor.removeItem(input.preset)
  const runtimeConfig = objectProperty(config.root, "runtimeConfig")
  const runtimeProperty = findProperty(config.root, "runtimeConfig")
  if (runtimeConfig && runtimeProperty) {
    const removals: Node[] = []
    if (editor.pruneRuntimeConfig(runtimeConfig, [], input.migrated, removals)) editor.removeItem(runtimeProperty)
    else for (const removal of removals) editor.removeItem(removal)
  }
  editor.removeUnusedBindings()
  const code = editor.output.toString()
  return { code, removedImports: editor.removedImports, lineOf: createLineResolver(code) }
}

export function findViteConfigName(cwd: string): string | undefined {
  return viteConfigNames.find(name => existsSync(join(cwd, name)))
}

export interface ViteConfigInput {
  cwd: string
  /** The nitro.config, whose language and code style the new vite.config follows. */
  nitroConfig: NuxtConfigFile
  env: EnvSource
  host?: string
  schemaModule?: SchemaModuleReference
  removePreset?: boolean
}

export interface ViteConfigResult {
  edit: FileEdit
  /** Line of the property at `path` in the `vitehub()` options, such as `["env", "server", "apiKey"]`. */
  lineOf: LineResolver
}

function importedLocal(config: NuxtConfigFile, source: string, name: string): string | undefined {
  for (const statement of config.program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source || statement.importKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
      if (imported === name) return specifier.local.name
    }
  }
  return undefined
}

function vitehubCall(input: ViteConfigInput, envName: string, indent: string, style: CodeStyle): string {
  const inner = `${indent}${style.indent}`
  const schemas = new Map<EnvField, string>()
  for (const [field, name] of input.schemaModule?.exports ?? []) {
    schemas.set(field, `${envName}.schemaFrom(${quoteString(input.schemaModule?.runtimePath ?? "", style)}, ${quoteString(name, style)})`)
  }
  const lines = [
    ...(input.host ? [`${inner}host: ${quoteString(input.host, style)},`] : []),
    `${inner}env: ${envExpression(input.env, envName, inner, style, schemas)},`,
  ]
  return `vitehub({\n${lines.join("\n")}\n${indent}})`
}

function vitehubLineResolver(code: string): LineResolver {
  let options: ObjectExpression | undefined
  try {
    walk(parseProgram(code), (node) => {
      const [argument] = node.type === "CallExpression" ? node.arguments : []
      if (!options && node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "vitehub" && argument?.type === "ObjectExpression") options = argument
    })
  }
  catch {
    return () => undefined
  }
  return (path, lookup) => {
    for (let length = path.length; length > (lookup?.exact ? path.length - 1 : 0); length--) {
      let object = options
      let property: ObjectProperty | undefined
      for (const segment of path.slice(0, length)) {
        property = object ? findProperty(object, segment) : undefined
        object = property?.value.type === "ObjectExpression" ? property.value : undefined
      }
      if (property) return line(property)
    }
    return undefined
  }
}

/** Writes a vite.config with `vitehub({ env })` and `nitro()`, or adds `vitehub()` to the plugins of an existing one. */
export async function writeViteConfig(input: ViteConfigInput): Promise<ViteConfigResult> {
  const existing = findViteConfigName(input.cwd)
  const after = existing ? await editViteConfig(input, existing) : newViteConfig(input)
  const edit: FileEdit = existing
    ? { path: existing, before: after.before, after: after.code }
    : { path: /\.[cm]?ts$/.test(input.nitroConfig.fileName) ? "vite.config.ts" : "vite.config.mjs", before: undefined, after: after.code }
  return { edit, lineOf: vitehubLineResolver(after.code) }
}

function newViteConfig(input: ViteConfigInput): { code: string, before?: string } {
  const style = new ConfigEditor(input.nitroConfig).style
  const semicolon = style.semicolons ? ";" : ""
  const imports = [["nitro", "nitro/vite"], ["defineConfig", "vite"], ["vitehub", "vite-hub"], ["env", "vite-hub/env"]]
    .map(([name, source]) => `import { ${name} } from ${quoteString(source ?? "", style)}${semicolon}`)
  const code = [
    ...imports,
    "",
    "export default defineConfig({",
    `${style.indent}plugins: [${vitehubCall(input, "env", style.indent, style)}, nitro()],`,
    `})${semicolon}`,
    "",
  ].join("\n")
  return { code }
}

async function editViteConfig(input: ViteConfigInput, fileName: string): Promise<{ code: string, before: string }> {
  const config = await readConfigFile(input.cwd, fileName, "defineConfig")
  if (importedLocal(config, "vite-hub", "vitehub")) throw codemodError(`${fileName} already uses vitehub(). Add the Env declarations to its env option by hand.`)
  if (!bindingFree(config, "vitehub")) throw codemodError(`${fileName} already declares vitehub. Rename it, then run the codemod again.`)
  const editor = new ConfigEditor(config)
  const style = editor.style
  const semicolon = style.semicolons ? ";" : ""
  const preset = input.removePreset ? vitePresetProperty(config) : undefined
  if (preset) editor.removeItem(preset)
  const envName = bindingFree(config, "env") ? "env" : "viteHubEnv"
  const nitroLocal = importedLocal(config, "nitro/vite", "nitro")
  const nitroName = nitroLocal ?? (bindingFree(config, "nitro") ? "nitro" : undefined)
  if (!nitroName) throw codemodError(`${fileName} already declares nitro. Rename it, then run the codemod again.`)
  const imports = [
    `import { vitehub } from ${quoteString("vite-hub", style)}${semicolon}`,
    `import { ${envName === "env" ? "env" : `env as ${envName}`} } from ${quoteString("vite-hub/env", style)}${semicolon}`,
  ]
  if (!nitroLocal) imports.unshift(`import { nitro } from ${quoteString("nitro/vite", style)}${semicolon}`)

  const pluginsProperty = findProperty(config.root, "plugins")
  if (!pluginsProperty) {
    const indent = editor.propertyIndent(config.root)
    editor.insertProperties(config.root, [`plugins: [${vitehubCall(input, envName, indent, style)}, ${nitroName}()]`], new Set())
  }
  else {
    const plugins = unwrapExpression(pluginsProperty.value)
    if (plugins.type !== "ArrayExpression") throw codemodError(`${fileName} sets plugins to an expression. Make it an array literal, then run the codemod again.`)
    const elements = plugins.elements.filter((element): element is NonNullable<typeof element> => element !== null)
    const nitroElement = nitroLocal
      ? elements.find((element) => {
          const value = unwrapExpression(element)
          return value.type === "CallExpression" && value.callee.type === "Identifier" && value.callee.name === nitroLocal
        })
      : undefined
    const first = nitroElement ?? elements[0]
    if (first) {
      const indent = indentAt(config.code, start(first))
      const multiline = config.code.slice(start(plugins), start(first)).includes("\n")
      editor.output.prependLeft(start(first), `${vitehubCall(input, envName, indent, style)},${multiline ? `\n${indent}` : " "}`)
      const last = elements.at(-1)
      if (!nitroElement && last) editor.output.appendLeft(end(last), `, ${nitroName}()`)
    }
    else {
      const indent = indentAt(config.code, start(pluginsProperty))
      editor.output.appendLeft(end(plugins) - 1, `${vitehubCall(input, envName, indent, style)}, ${nitroName}()`)
    }
  }
  editor.addImport(imports.join("\n"))
  return { code: editor.output.toString(), before: config.code }
}
