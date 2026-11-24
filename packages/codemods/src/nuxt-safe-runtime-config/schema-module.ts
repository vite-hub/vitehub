import { existsSync } from "node:fs"
import { isAbsolute, join, posix } from "node:path"

import { end, findProperty, indentAt, isReference, quoteString, start, walk } from "@vite-hub/internal/ast"

import { literalValue, staticOptionsObject, unwrapExpression } from "../shared/nuxt-config.ts"
import { codemodError } from "../error-diagnostics.ts"
import { flatPublicName } from "./fields.ts"

import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { ImportDeclaration } from "@babel/types"
import type { NuxtConfigFile } from "../shared/nuxt-config.ts"
import type { AccessStep } from "./field-schema.ts"
import type { EnvField } from "./fields.ts"

type SchemaSource =
  | { kind: "module", specifier: string }
  | { kind: "inline", binding: string, expression: string, imports: ImportDeclaration[], sources: string[], references: string[] }

/** Where the codemod writes the schema module, and what the module imports. */
export interface SchemaModuleTarget {
  /** Path from the project directory, such as `server/env.schema.ts`. */
  path: string
  /** The `env.schemaFrom()` specifier, such as `./server/env.schema.ts`. */
  runtimePath: string
  /** The specifier that nuxt.config imports, such as `./server/env.schema`. */
  importPath: string
  source: SchemaSource
}

export interface SchemaModule {
  code: string
  /** Export name of each field schema. */
  exports: Map<EnvField, string>
  /** Packages and files that the module imports for an inline `$schema`. */
  importedSources: string[]
}

const reservedWords = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "eval",
  "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
  "null", "package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
  "undefined", "var", "void", "while", "with", "yield",
])

function serverDirectory(config: NuxtConfigFile): string {
  const property = findProperty(config.root, "serverDir")
  const value = property ? literalValue(property.value) : undefined
  if (typeof value !== "string" || isAbsolute(value)) return "server"
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/\/+$/, "")
  return normalized && normalized !== "." && !normalized.startsWith("../") && normalized !== ".." ? normalized : "server"
}

function relativeSpecifier(from: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier
  const path = posix.relative(from, posix.normalize(specifier))
  return path.startsWith(".") ? path : `./${path}`
}

function findSchemaProperty(options: readonly (Node | undefined)[]) {
  for (const option of options) {
    const object = option ? unwrapExpression(option) : undefined
    if (object?.type !== "ObjectExpression") continue
    const property = findProperty(object, "$schema")
    if (property) return property
  }
  return undefined
}

function topLevelBindings(config: NuxtConfigFile) {
  const imports = new Map<string, ImportDeclaration>()
  const locals = new Set<string>()
  const declarators = new Map<string, Node>()
  for (const statement of config.program.program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) imports.set(specifier.local.name, statement)
      continue
    }
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        for (const name of patternNames(declarator.id)) locals.add(name)
        if (declaration.kind === "const" && declarator.id.type === "Identifier" && declarator.init) declarators.set(declarator.id.name, declarator.init)
      }
    }
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id) locals.add(declaration.id.name)
  }
  return { imports, locals, declarators }
}

function patternNames(node: Node | null | undefined): string[] {
  if (!node) return []
  switch (node.type) {
    case "Identifier": return [node.name]
    case "ObjectPattern": return node.properties.flatMap(entry => patternNames(entry.type === "RestElement" ? entry.argument : entry.value))
    case "ArrayPattern": return node.elements.flatMap(patternNames)
    case "AssignmentPattern": return patternNames(node.left)
    case "RestElement": return patternNames(node.argument)
    default: return []
  }
}

function dedent(code: string, indent: string): string {
  return indent ? code.split("\n").map((text, index) => index && text.startsWith(indent) ? text.slice(indent.length) : text).join("\n") : code
}

/**
 * Chooses the schema module path and reads what it must import. Returns a reason instead when the `$schema` cannot
 * move to a module: it uses other nuxt.config bindings, or the codemod cannot find its code.
 */
export function planSchemaModule(input: {
  cwd: string
  config: NuxtConfigFile
  schemaPath?: string
  options: readonly (Node | undefined)[]
}): { target: SchemaModuleTarget } | { reason: string } {
  const { config } = input
  const directory = serverDirectory(config)
  const extension = /\.[cm]?ts$/.test(config.fileName) ? ".ts" : ".mjs"
  const candidates = ["env.schema", "runtime-config.schema"].map(name => `${directory}/${name}${extension}`)
  const path = candidates.find(candidate => !existsSync(join(input.cwd, candidate)))
  if (!path) return { reason: `${candidates.join(" and ")} already exist, so the codemod wrote no schema module.` }
  const importPath = `./${extension === ".ts" ? path.slice(0, -extension.length) : path}`
  const base = { path, runtimePath: `./${path}`, importPath }
  const moduleDirectory = posix.dirname(path)

  if (input.schemaPath !== undefined) {
    return { target: { ...base, source: { kind: "module", specifier: relativeSpecifier(moduleDirectory, input.schemaPath) } } }
  }

  for (const option of input.options) {
    if (option && unwrapExpression(option).type === "ObjectExpression" && !staticOptionsObject(option)) {
      throw codemodError(`The module options in ${config.fileName} have a spread, a computed key, or a repeated key, so the codemod cannot tell which $schema the module used. Write $schema once, without a spread, then run the codemod again.`)
    }
  }
  const property = findSchemaProperty(input.options)
  if (!property) return { reason: "The codemod cannot find the code of the inline $schema." }
  const { imports, locals, declarators } = topLevelBindings(config)
  let expression = unwrapExpression(property.value)
  let binding = "runtimeConfigSchema"
  if (expression.type === "Identifier") {
    const init = declarators.get(expression.name)
    if (!init) return { reason: `The inline $schema reads ${expression.name}, which is not a top-level const in ${config.fileName}.` }
    binding = expression.name
    expression = init
  }
  const used = new Set<ImportDeclaration>()
  const localNames = new Set<string>()
  const references = new Set<string>()
  walk(expression, (node, ancestors) => {
    if (!isReference(node, ancestors.at(-1))) return
    references.add(node.name)
    const declaration = imports.get(node.name)
    if (declaration) used.add(declaration)
    else if (locals.has(node.name)) localNames.add(node.name)
  })
  if (localNames.size) {
    return { reason: `The inline $schema uses ${[...localNames].sort().join(", ")} from ${config.fileName}, so the codemod cannot move it to a schema module.` }
  }
  const code = config.code.slice(start(expression), end(expression))
  const declarations = [...used].map(declaration => ({
    ...declaration,
    source: { ...declaration.source, value: relativeSpecifier(moduleDirectory, declaration.source.value) },
  }))
  const sources = [...used].map(declaration => declaration.source.value)
  return { target: { ...base, source: { kind: "inline", binding, expression: dedent(code, indentAt(config.code, start(expression))), imports: declarations, sources, references: [...references] } } }
}

function identifierName(name: string): string {
  const cleaned = name.replaceAll(/[^\w$]/g, "_")
  const identifier = /^\d/.test(cleaned) ? `_${cleaned}` : cleaned
  return reservedWords.has(identifier) ? `${identifier}Schema` : identifier
}

function exportName(field: EnvField): string {
  const name = flatPublicName(field.configPath)
  return identifierName(field.section === "public" ? `public${name.charAt(0).toUpperCase()}${name.slice(1)}` : name)
}

function renderStep(step: AccessStep, style: CodeStyle): string {
  if (step.kind === "call") return `.${step.name}(${step.args.map(arg => quoteString(arg, style)).join(", ")})`
  return /^[A-Za-z_$][\w$]*$/.test(step.name) ? `.${step.name}` : `[${quoteString(step.name, style)}]`
}

function renderImport(declaration: ImportDeclaration, style: CodeStyle, semicolon: string): string {
  const clauses: string[] = []
  const named: string[] = []
  for (const specifier of declaration.specifiers) {
    if (specifier.type === "ImportDefaultSpecifier") clauses.unshift(specifier.local.name)
    else if (specifier.type === "ImportNamespaceSpecifier") clauses.push(`* as ${specifier.local.name}`)
    else {
      const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : quoteString(specifier.imported.value, style)
      const kind = specifier.importKind === "type" ? "type " : ""
      named.push(`${kind}${imported === specifier.local.name ? imported : `${imported} as ${specifier.local.name}`}`)
    }
  }
  if (named.length) clauses.push(`{ ${named.join(", ")} }`)
  return `import ${declaration.importKind === "type" ? "type " : ""}${clauses.join(", ")} from ${quoteString(declaration.source.value, style)}${semicolon}`
}

/** Writes the module that exports the schema of each field in `fields`. */
export function renderSchemaModule(target: SchemaModuleTarget, fields: readonly EnvField[], style: CodeStyle): SchemaModule {
  const semicolon = style.semicolons ? ";" : ""
  const source = target.source
  const locals = new Set(source.kind === "inline" ? [...source.references, ...source.imports.flatMap(declaration => declaration.specifiers.map(specifier => specifier.local.name))] : [])
  const fresh = (base: string, taken: Set<string>) => {
    let name = base
    for (let index = 2; taken.has(name); index++) name = `${base}${index}`
    taken.add(name)
    return name
  }
  const binding = fresh(source.kind === "inline" ? source.binding : "runtimeConfigSchema", locals)
  const exportNames = new Set<string>()
  const exports = new Map<EnvField, string>()
  const lines: string[] = []
  const aliases: string[] = []
  for (const field of fields) {
    if (!field.schema) continue
    const name = fresh(exportName(field), exportNames)
    const local = fresh(name, locals)
    exports.set(field, name)
    const value = `${binding}${field.schema.steps.map(step => renderStep(step, style)).join("")}${semicolon}`
    if (local === name) {
      lines.push(`export const ${name} = ${value}`)
    }
    else {
      lines.push(`const ${local} = ${value}`)
      aliases.push(`${local} as ${name}`)
    }
  }
  if (aliases.length) lines.push(`export { ${aliases.join(", ")} }${semicolon}`)
  const head = source.kind === "inline"
    ? [...source.imports.map(declaration => renderImport(declaration, style, semicolon)), "", `const ${binding} = ${source.expression}${semicolon}`]
    : [`import ${binding} from ${quoteString(source.specifier, style)}${semicolon}`]
  return {
    code: `${[...head, "", ...lines].join("\n").replace(/^\n+/, "")}\n`,
    exports,
    importedSources: source.kind === "inline" ? source.sources : [],
  }
}
