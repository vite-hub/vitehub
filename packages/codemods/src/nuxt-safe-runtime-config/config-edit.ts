import { findProperty, quoteString } from "@vite-hub/internal/ast"

import { addViteHubOptions, bindingFree, ConfigEditor, createLineResolver, literal, propertyKey, useViteHubModule } from "../shared/config-editor.ts"
import { objectProperty } from "../shared/nuxt-config.ts"
import { CodemodError } from "../types.ts"
import { moduleName } from "./nuxt-config.ts"

import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { LineResolver } from "../shared/config-editor.ts"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { EnvField } from "./fields.ts"

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
  /** ViteHub host that the codemod set, if any. */
  host?: string
  hostNote?: string
  imports: string[]
  /** Sources of the imports that only the removed code used, such as `valibot`. */
  removedImports: string[]
  /** Line of the property at `path` from the config root in the new code, or of its nearest parent. */
  lineOf: LineResolver
}

export function declarationCode(field: EnvField, envName: string, style: CodeStyle): string {
  const options: string[] = []
  if (field.default !== undefined) options.push(`default: ${literal(field.default, style)}`)
  if (field.section === "public") options.push(`mode: ${quoteString("build", style)}`)
  if (!field.required) options.push("required: false")
  if (field.secret) options.push("secret: true")
  const names = [...new Set([field.variable, ...(field.extraVariables ?? [])])]
  const source = names.length === 1 ? quoteString(field.variable, style) : `[${names.map(name => quoteString(name, style)).join(", ")}]`
  options.push(`source: ${envName}.source(${source}${field.skipEmpty ? ", { skipEmpty: true }" : ""})`)
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

/** Renders the value of `vitehub.env`. `indent` is the indentation of the `env` key line. */
export function envExpression(env: EnvSource, envName: string, indent: string, style: CodeStyle): string {
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

/** Edits nuxt.config: swaps the module, removes `safeRuntimeConfig` and migrated keys, and adds `vitehub.env`. */
export function editNuxtConfig(input: ConfigEditInput): ConfigEditResult {
  const { config } = input
  const editor = new ConfigEditor(config)
  const style = editor.style
  const removedRootProperties = new Set<Node>()

  const rootEntries = useViteHubModule(editor, config, moduleName)

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

  const env = input.env
  const { host, hostNote } = addViteHubOptions(editor, config, {
    options: [{ key: "env", value: indent => envExpression(env, envName, indent, style), label: "the Env declarations" }],
    rootEntries,
    removedRootProperties,
  })
  editor.removeUnusedBindings()
  for (const text of imports) editor.addImport(text)

  const code = editor.output.toString()
  return {
    code,
    host,
    hostNote,
    imports: input.env.kind === "fields" ? ["vite-hub/env"] : ["@vite-hub/env/vite"],
    removedImports: editor.removedImports,
    lineOf: createLineResolver(code),
  }
}
