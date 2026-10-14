import { readdirSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { CmsPresetOptions } from "./presets/cms.ts"

/** Import paths that select the `cms` preset in `server/content.ts`. */
export const cmsPresetModules: readonly string[] = ["vite-hub/content/presets/cms", "@vite-hub/content/presets/cms"]

const cmsOptionKeys: ReadonlySet<string> = new Set(["blob", "database", "workspace"])
const namePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i

/** How `server/content.ts` selects the `cms` preset, read from its source without running it. */
export interface CmsPresetUsage {
  /** The Content Definition file. */
  file: string
  /** Options from `extends: [cms, options]`. Empty for `extends: cms`. */
  options: CmsPresetOptions
}

/** The resources that the `cms` preset borrows, resolved for one app. */
export interface CmsPresetPlan extends CmsPresetUsage {
  blob: string
  database: string
  /**
   * How the Database was chosen: the default-or-only rule, the `database` option, or `preset` when the app has no
   * Database Definition and the preset adds the `default` Database.
   */
  databaseReason: "default" | "only" | "option" | "preset"
  workspace: string
}

interface AstNode {
  type: string
  [key: string]: unknown
}

type ParseAst = (source: string, options: { lang: "ts" | "tsx" | "js" | "jsx" }) => unknown

function isNode(value: unknown): value is AstNode {
  return value !== null && Object(value) === value && String(Reflect.get(Object(value), "type")) === Reflect.get(Object(value), "type")
}

/** Drop type-only and grouping wrappers such as `x satisfies T`, `x as T`, and `(x)`. */
function unwrap(node: unknown): unknown {
  let current = node
  while (isNode(current) && ["ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(current.type)) {
    current = current.expression
  }
  return current
}

function propertyName(node: AstNode): string | undefined {
  if (node.type !== "Property" || node.computed === true) return
  const key = node.key
  if (!isNode(key)) return
  if (key.type === "Identifier") return String(key.name)
  if (key.type === "Literal" && String(key.value) === key.value) return key.value
}

function stringValue(node: unknown): string | undefined {
  const value = unwrap(node)
  if (!isNode(value)) return
  if (value.type === "Literal" && String(value.value) === value.value) return value.value
  if (value.type === "TemplateLiteral" && Array.isArray(value.expressions) && !value.expressions.length && Array.isArray(value.quasis) && value.quasis.length === 1) {
    const quasi = value.quasis[0]
    const cooked: unknown = isNode(quasi) ? Reflect.get(Object(quasi.value), "cooked") : undefined
    if (String(cooked) === cooked) return cooked
  }
}

function displayPath(file: string, projectRoot: string): string {
  return JSON.stringify(relative(projectRoot, file).replaceAll("\\", "/"))
}

/** The build cannot read how the Definition selects the preset. */
function presetError(file: string, projectRoot: string, message: string): Error {
  return contentErrorDiagnostics.CONTENT_B0001({ message: `[vitehub] ${displayPath(file, projectRoot)}: ${message}` })
}

/** The app lacks something the preset needs. */
export function cmsRequirementError(file: string, projectRoot: string, message: string): Error {
  return contentErrorDiagnostics.CONTENT_B0002({ message: `[vitehub] ${displayPath(file, projectRoot)} uses the Content cms preset: ${message}` })
}

/**
 * Read how `server/content.ts` selects the `cms` preset. The build cannot run the Definition, so the preset must be
 * imported from `vite-hub/content/presets/cms` and passed as `extends: cms` or `extends: [cms, { ... }]` with string
 * literal options. Returns undefined when the file does not import the preset.
 */
export function readCmsPresetUsage(source: string, file: string, projectRoot: string, parseAst: ParseAst): CmsPresetUsage | undefined {
  if (!cmsPresetModules.some(module => source.includes(module))) return
  const lang = /\.[cm]?tsx$/.test(file) ? "tsx" : /\.[cm]?jsx$/.test(file) ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js"
  const program = parseAst(source, { lang })
  if (!isNode(program)) return
  const bindings = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement) || statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    const from = isNode(statement.source) ? statement.source.value : undefined
    if (String(from) !== from || !cmsPresetModules.includes(from)) continue
    for (const specifier of Array.isArray(statement.specifiers) ? statement.specifiers : []) {
      if (!isNode(specifier) || !isNode(specifier.local) || specifier.importKind === "type") continue
      const local = String(specifier.local.name)
      if (specifier.type === "ImportDefaultSpecifier") bindings.add(local)
      else if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local)
      else if (specifier.type === "ImportSpecifier" && isNode(specifier.imported)) {
        const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
        if (imported === "cms" || imported === "default") bindings.add(local)
      }
    }
  }
  if (!bindings.size && !namespaces.size) return

  const defineContentBindings = new Set<string>()
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement) || statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    const from = isNode(statement.source) ? statement.source.value : undefined
    if (from !== "vite-hub/content" && from !== "@vite-hub/content") continue
    for (const specifier of Array.isArray(statement.specifiers) ? statement.specifiers : []) {
      if (!isNode(specifier) || specifier.type !== "ImportSpecifier" || !isNode(specifier.local) || !isNode(specifier.imported)) continue
      const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
      if (imported === "defineContent") defineContentBindings.add(String(specifier.local.name))
    }
  }

  const isPreset = (node: unknown): boolean => {
    const value = unwrap(node)
    if (!isNode(value)) return false
    if (value.type === "Identifier") return bindings.has(String(value.name))
    if (value.type !== "MemberExpression" || value.computed === true || !isNode(value.object) || !isNode(value.property)) return false
    return value.object.type === "Identifier" && namespaces.has(String(value.object.name))
      && (value.property.name === "cms" || value.property.name === "default")
  }

  // Only inspect the options object passed to the exported `content` Definition. Other
  // objects in this module may use an `extends` property for unrelated purposes.
  let contentOptions: AstNode | undefined
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement) || statement.type !== "ExportNamedDeclaration") continue
    const declaration = statement.declaration
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue
    for (const declarator of Array.isArray(declaration.declarations) ? declaration.declarations : []) {
      if (!isNode(declarator) || !isNode(declarator.id) || declarator.id.type !== "Identifier" || declarator.id.name !== "content") continue
      const init = unwrap(declarator.init)
      if (!isNode(init) || init.type !== "CallExpression" || !isNode(init.callee) || init.callee.type !== "Identifier" || !defineContentBindings.has(String(init.callee.name))) continue
      const argument = unwrap(Array.isArray(init.arguments) ? init.arguments[0] : undefined)
      if (isNode(argument) && argument.type === "ObjectExpression") contentOptions = argument
    }
  }

  const selections: unknown[] = []
  if (contentOptions) {
    for (const property of Array.isArray(contentOptions.properties) ? contentOptions.properties : []) {
      if (!isNode(property) || propertyName(property) !== "extends") continue
      const value = unwrap(property.value)
      if (isPreset(value)) selections.push(value)
      else if (isNode(value) && value.type === "ArrayExpression" && Array.isArray(value.elements) && isPreset(value.elements[0])) selections.push(value)
    }
  }

  const usage = "Pass it as defineContent({ extends: cms }) or defineContent({ extends: [cms, { database, blob, workspace }] }) in the exported content Definition."
  if (!selections.length) throw presetError(file, projectRoot, `imports the Content cms preset but does not select it with extends. ${usage}`)
  if (selections.length > 1) throw presetError(file, projectRoot, `selects the Content cms preset more than once. ${usage}`)
  const selection = selections[0]
  if (!isNode(selection) || selection.type !== "ArrayExpression") return { file, options: {} }

  const elements = Array.isArray(selection.elements) ? selection.elements : []
  const optionsNode = unwrap(elements[1])
  if (elements.length !== 2 || !isNode(optionsNode) || optionsNode.type !== "ObjectExpression") {
    throw presetError(file, projectRoot, `the cms preset tuple must be [cms, { ... }] with an object literal. ${usage}`)
  }
  const options: CmsPresetOptions = {}
  for (const property of Array.isArray(optionsNode.properties) ? optionsNode.properties : []) {
    const key = isNode(property) ? propertyName(property) : undefined
    if (!isNode(property) || key === undefined || property.kind !== "init" || property.method === true) {
      throw presetError(file, projectRoot, "cms preset options must be plain properties with string literal values, because the build reads them without running the file.")
    }
    if (!cmsOptionKeys.has(key)) {
      throw presetError(file, projectRoot, `unknown cms preset option ${JSON.stringify(key)}. Use database, blob, or workspace.`)
    }
    const valueNode = unwrap(property.value)
    // `database: undefined` keeps the default, like omitting the key.
    if (isNode(valueNode) && valueNode.type === "Identifier" && valueNode.name === "undefined") continue
    const value = stringValue(valueNode)
    if (value === undefined) {
      throw presetError(file, projectRoot, `cms preset option ${JSON.stringify(key)} must be a string literal, because the build reads it without running the file.`)
    }
    if (!namePattern.test(value)) {
      throw presetError(file, projectRoot, `cms preset option ${JSON.stringify(key)} must be a name of letters, numbers, dots, underscores, dashes, and slashes.`)
    }
    // SAFETY: key is one of the option names checked above.
    options[key as keyof CmsPresetOptions] = value
  }
  return { file, options }
}

/** Database names and how to pick one, from `@vite-hub/database/config`. */
export interface CmsDatabaseChoices {
  names: readonly string[]
  resolveDefault(names: readonly string[]): { status: "resolved", name: string, reason: "default" | "only" } | { status: "ambiguous", names: string[] } | { status: "none" }
}

/** Pick the Database, Blob store, and Workspace name that the preset uses. Fails with the option to set. */
export function resolveCmsPresetPlan(usage: CmsPresetUsage, databases: CmsDatabaseChoices, projectRoot: string): CmsPresetPlan {
  const blob = usage.options.blob ?? "default"
  const workspace = usage.options.workspace ?? "content"
  const choices = databases.names.length ? [...databases.names].sort().map(name => JSON.stringify(name)).join(", ") : "none"
  if (usage.options.database !== undefined) {
    if (!databases.names.includes(usage.options.database)) {
      throw cmsRequirementError(usage.file, projectRoot, `option database is ${JSON.stringify(usage.options.database)}, but no Database Definition has that name. Database Definitions: ${choices}.`)
    }
    return { ...usage, blob, database: usage.options.database, databaseReason: "option", workspace }
  }
  const resolution = databases.resolveDefault(databases.names)
  // Without a Database Definition the preset adds the `default` Database, so the app needs no database files.
  if (resolution.status === "none") return { ...usage, blob, database: "default", databaseReason: "preset", workspace }
  if (resolution.status === "ambiguous") {
    throw cmsRequirementError(usage.file, projectRoot, `it needs one Database, but the app has several and none is named "default": ${choices}. Choose one with extends: [cms, { database: ${JSON.stringify(resolution.names[0])} }].`)
  }
  return { ...usage, blob, database: resolution.name, databaseReason: resolution.reason, workspace }
}

/** Read the Definition file and its preset usage. */
export async function readCmsPresetUsageFile(file: string, projectRoot: string, parseAst: ParseAst): Promise<CmsPresetUsage | undefined> {
  return readCmsPresetUsage(await readFile(file, "utf8"), resolve(file), projectRoot, parseAst)
}

const contentFilePattern = /^content\.[cm]?[jt]s$/

/**
 * Whether `server/content.ts` selects the `cms` preset, read synchronously so `vitehub()` can enable Workspace,
 * Database, and Blob while Vite filters plugins. Returns false when the file is missing or ambiguous; the Source and
 * Content plugins report those cases.
 */
export function usesCmsPresetSync(input: { projectRoot: string, serverDirs?: readonly string[] }, parseAst: ParseAst): boolean {
  const root = resolve(input.projectRoot)
  const serverDirs = input.serverDirs?.map(directory => resolve(root, directory)) ?? [resolve(root, "server")]
  const files = serverDirs.flatMap((directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && contentFilePattern.test(entry.name))
        .map(entry => join(directory, entry.name))
    }
    catch {
      return []
    }
  })
  if (files.length !== 1) return false
  const file = files[0]!
  const source = readFileSync(file, "utf8")
  // Vite asks once per plugin while it filters them, so parse each version of the file once.
  if (lastPresetCheck?.file !== file || lastPresetCheck.source !== source) {
    lastPresetCheck = { file, source, uses: Boolean(readCmsPresetUsage(source, file, root, parseAst)) }
  }
  return lastPresetCheck.uses
}

let lastPresetCheck: { file: string, source: string, uses: boolean } | undefined

/** Import paths that the generated Workspace module uses. */
export interface CmsWorkspaceImports {
  /** Exports `blob`. */
  blob: string
  /** Exports `createBlobDatabaseWorkspaceStore` and `workspaceHistorySchema`. */
  blobDatabase: string
  /** Exports `useDatabase`. */
  database: string
  /** Exports `defineDatabase`, for the Database Definition the preset adds when the app has none. */
  databaseDefinition: string
  /** Exports `defineWorkspace`. */
  workspace: string
}

/** Export of the generated module that holds the Workspace Definition. */
export const cmsWorkspaceExport = "contentWorkspace"

/**
 * The generated Workspace Definition module. It only reads the Database registry and creates a lazy Blob store when
 * it loads, so the build can load it to bundle Workspace assets.
 */
export function renderCmsWorkspaceModule(plan: CmsPresetPlan, imports: Omit<CmsWorkspaceImports, "databaseDefinition">): string {
  const missing = `[vitehub] The Content cms preset needs Database ${JSON.stringify(plan.database)}, but it is not configured at runtime. Enable database in vitehub() and keep its Database Definition.`
  return [
    "// Generated by @vite-hub/content for the cms preset in server/content.ts. Do not edit.",
    `import { blob } from ${JSON.stringify(imports.blob)}`,
    `import { useDatabase } from ${JSON.stringify(imports.database)}`,
    `import { defineWorkspace } from ${JSON.stringify(imports.workspace)}`,
    `import { createBlobDatabaseWorkspaceStore } from ${JSON.stringify(imports.blobDatabase)}`,
    "",
    `const database = useDatabase(${JSON.stringify(plan.database)})?.db ?? new Proxy({}, {`,
    "  get() {",
    `    throw new Error(${JSON.stringify(missing)})`,
    "  },",
    "})",
    "",
    `export const ${cmsWorkspaceExport} = defineWorkspace({`,
    "  store: createBlobDatabaseWorkspaceStore({",
    `    blob: blob.store(${JSON.stringify(plan.blob)}),`,
    "    database,",
    `    workspace: ${JSON.stringify(plan.workspace)},`,
    "  }),",
    "})",
    "",
  ].join("\n")
}

/** Why the preset adds the `default` Database. Inspection shows it. */
export function cmsDatabaseReason(file: string, projectRoot: string): string {
  return `${displayPath(file, projectRoot)} uses the Content cms preset and the app has no Database Definition. Add server/databases/config.ts to define this Database yourself.`
}

/** The Database Definition that the preset adds when the app has none. */
export function renderCmsDatabaseModule(imports: Pick<CmsWorkspaceImports, "databaseDefinition">): string {
  return [
    "// Generated by @vite-hub/content for the cms preset in server/content.ts. Do not edit.",
    "// The app has no Database Definition, so the preset adds the `default` Database. Its migrations live in",
    "// server/databases/migrations. Add server/databases/config.ts to define the Database yourself.",
    `import { defineDatabase } from ${JSON.stringify(imports.databaseDefinition)}`,
    "",
    "export default defineDatabase({ schema: {} })",
    "",
  ].join("\n")
}
