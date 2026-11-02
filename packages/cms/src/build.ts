import { existsSync, readdirSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import { cmsErrorDiagnostics } from "./error-diagnostics.ts"
import { cmsGitHubDefaults, cmsOptionKeys, cmsOptionProblem, cmsOptionsProblem, cmsStoreOf } from "./options.ts"

import type { CmsPresetOptions } from "./index.ts"

/** Import paths that select the `cms` preset in `server/content.ts`. */
export const cmsPresetModules: readonly string[] = ["vite-hub/cms", "@vite-hub/cms"]

/** How `server/content.ts` selects the `cms` preset, read from its source without running it. */
export interface CmsPresetUsage {
  /** The Content Definition file. */
  file: string
  /** Options from `extends: [cms, options]`. Empty for `extends: cms`. */
  options: CmsPresetOptions
  /** Whether `defineContent()` passes its own `authorize`, or a spread makes its presence unknown. */
  authorize?: true | "unknown"
}

/** The GitHub store of the `cms` preset, with defaults filled in. */
export interface CmsGitHubPlan {
  /** `owner/name`. Without it the store reads `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` when it is first used. */
  repo?: string
  /** The published branch. */
  branch: string
  /** The branch that holds drafts. */
  draftBranch: string
  /** The folder in the repository, or `""` for the repository root. */
  root: string
  publish: "commit" | "pr"
}

/** The resources that the `cms` preset borrows, resolved for one app. */
export interface CmsPresetPlan extends CmsPresetUsage {
  /** Where documents live: the Blob + Database store, or a GitHub repository. */
  store: "blob-database" | "github"
  /** The Blob store. Undefined for the GitHub store, which keeps files in Git. */
  blob?: string
  /** Set for the GitHub store. */
  github?: CmsGitHubPlan
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
  return cmsErrorDiagnostics.CONTENT_B0001({ message: `[vitehub] ${displayPath(file, projectRoot)}: ${message}` })
}

/** The app lacks something the preset needs. */
export function cmsRequirementError(file: string, projectRoot: string, message: string): Error {
  return cmsErrorDiagnostics.CONTENT_B0002({ message: `[vitehub] ${displayPath(file, projectRoot)} uses the Content cms preset: ${message}` })
}

/**
 * Read how `server/content.ts` selects the `cms` preset. The build cannot run the Definition, so the preset must be
 * imported from `vite-hub/cms` or `@vite-hub/cms` and passed as `extends: cms` or `extends: [cms, { ... }]` with string
 * literal options. Returns undefined when the file does not import the preset.
 */
export function readCmsPresetUsage(source: string, file: string, projectRoot: string, parseAst: ParseAst): CmsPresetUsage | undefined {
  return readCmsPresetUsageInternal(source, file, projectRoot, parseAst, new Set())
}

function readCmsPresetUsageInternal(source: string, file: string, projectRoot: string, parseAst: ParseAst, seen: Set<string>): CmsPresetUsage | undefined {
  const resolvedFile = resolve(file)
  if (seen.has(resolvedFile)) return
  seen.add(resolvedFile)
  const lang = /\.[cm]?tsx$/.test(file) ? "tsx" : /\.[cm]?jsx$/.test(file) ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js"
  const program = parseAst(source, { lang })
  if (!isNode(program)) return
  // Content discovery accepts relative re-exports. Follow one statically resolvable
  // target so CMS selection is read from the module that defines `content`.
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement) || statement.type !== "ExportNamedDeclaration" || !isNode(statement.source)) continue
    const exported = Array.isArray(statement.specifiers) && statement.specifiers.some((specifier) => {
      if (!isNode(specifier) || specifier.type !== "ExportSpecifier" || !isNode(specifier.exported)) return false
      const name = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
      return name === "content"
    })
    const specifier = statement.source.value
    if (!exported || typeof specifier !== "string" || !specifier.startsWith(".")) continue
    const base = resolve(file, "..", specifier)
    const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map(ext => `${base}${ext}`), ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mts", "index.cts", "index.mjs", "index.cjs"].map(name => join(base, name))]
    const target = candidates.find(candidate => existsSync(candidate))
    if (target) {
      const usage = readCmsPresetUsageInternal(readFileSync(target, "utf8"), target, projectRoot, parseAst, seen)
      if (usage) return usage
    }
  }
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement) || statement.type !== "ExportAllDeclaration" || !isNode(statement.source)) continue
    const specifier = statement.source.value
    if (typeof specifier !== "string" || !specifier.startsWith(".")) continue
    const base = resolve(file, "..", specifier)
    const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map(ext => `${base}${ext}`), ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mts", "index.cts", "index.mjs", "index.cjs"].map(name => join(base, name))]
    const target = candidates.find(candidate => existsSync(candidate))
    if (target) {
      const usage = readCmsPresetUsageInternal(readFileSync(target, "utf8"), target, projectRoot, parseAst, seen)
      if (usage) return usage
    }
  }
  if (!cmsPresetModules.some(module => source.includes(module))) return
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
  // objects in this module may use an `extends` property for unrelated purposes. The
  // source discovery accepts both `export const content = ...` and
  // `const content = ...; export { content }`, so follow both forms here.
  const exportedContentBindings = new Set<string>()
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement) || statement.type !== "ExportNamedDeclaration") continue
    const declaration = statement.declaration
    if (isNode(declaration) && declaration.type === "VariableDeclaration") {
      for (const declarator of Array.isArray(declaration.declarations) ? declaration.declarations : []) {
        if (isNode(declarator) && isNode(declarator.id) && declarator.id.type === "Identifier" && declarator.id.name === "content") {
          exportedContentBindings.add(String(declarator.id.name))
        }
      }
    }
    for (const specifier of Array.isArray(statement.specifiers) ? statement.specifiers : []) {
      if (!isNode(specifier) || specifier.type !== "ExportSpecifier" || !isNode(specifier.local) || !isNode(specifier.exported)) continue
      const exported = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
      if (exported === "content") exportedContentBindings.add(String(specifier.local.name))
    }
  }
  let contentOptions: AstNode | undefined
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isNode(statement)) continue
    if (statement.type === "ExportDefaultDeclaration") {
      const init = unwrap(statement.declaration)
      if (isNode(init) && init.type === "CallExpression" && isNode(init.callee) && init.callee.type === "Identifier" && defineContentBindings.has(String(init.callee.name))) {
        const argument = unwrap(Array.isArray(init.arguments) ? init.arguments[0] : undefined)
        if (isNode(argument) && argument.type === "ObjectExpression") contentOptions = argument
      }
      continue
    }
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue
    for (const declarator of Array.isArray(declaration.declarations) ? declaration.declarations : []) {
      if (!isNode(declarator) || !isNode(declarator.id) || declarator.id.type !== "Identifier" || !exportedContentBindings.has(String(declarator.id.name))) continue
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

  const usage = `Pass it as defineContent({ extends: cms }) or defineContent({ extends: [cms, { ${cmsOptionKeys.join(", ")} }] }) in the exported content Definition.`
  if (!selections.length) throw presetError(file, projectRoot, `imports the Content cms preset but does not select it with extends. ${usage}`)
  if (selections.length > 1) throw presetError(file, projectRoot, `selects the Content cms preset more than once. ${usage}`)
  const selection = selections[0]
  let ownPolicy: CmsPresetUsage["authorize"]
  for (const property of Array.isArray(contentOptions?.properties) ? contentOptions.properties : []) {
    if (!isNode(property)) continue
    if (property.type === "SpreadElement") {
      ownPolicy = "unknown"
      continue
    }
    if (propertyName(property) !== "authorize") continue
    const value = unwrap(property.value)
    const absent = isNode(value) && ((value.type === "Identifier" && value.name === "undefined") || (value.type === "UnaryExpression" && value.operator === "void"))
    ownPolicy = absent ? undefined : true
  }
  const access = ownPolicy ? { authorize: ownPolicy } : {}
  if (!isNode(selection) || selection.type !== "ArrayExpression") return { file, options: {}, ...access }

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
    if (!cmsOptionKeys.includes(key)) {
      throw presetError(file, projectRoot, `unknown cms preset option ${JSON.stringify(key)}. Use ${cmsOptionKeys.join(", ")}.`)
    }
    const valueNode = unwrap(property.value)
    // `database: undefined` keeps the default, like omitting the key.
    if (isNode(valueNode) && valueNode.type === "Identifier" && valueNode.name === "undefined") continue
    const value = stringValue(valueNode)
    if (value === undefined) {
      throw presetError(file, projectRoot, `cms preset option ${JSON.stringify(key)} must be a string literal, because the build reads it without running the file.`)
    }
    const problem = cmsOptionProblem(key, value)
    if (problem) throw presetError(file, projectRoot, `cms preset option ${JSON.stringify(key)} ${problem}`)
    // SAFETY: key is one of the option names and value is a valid string for it, both checked above.
    Reflect.set(options, key, value)
  }
  const problem = cmsOptionsProblem(options)
  if (problem) throw presetError(file, projectRoot, `cms preset ${problem}`)
  return { file, options, ...access }
}

/** Database names and how to pick one, from `@vite-hub/database/config`. */
export interface CmsDatabaseChoices {
  names: readonly string[]
  resolveDefault(names: readonly string[]): { status: "resolved", name: string, reason: "default" | "only" } | { status: "ambiguous", names: string[] } | { status: "none" }
}

/** Pick the Database, Blob store, and Workspace name that the preset uses. Fails with the option to set. */
export function resolveCmsPresetPlan(usage: CmsPresetUsage, databases: CmsDatabaseChoices, projectRoot: string): CmsPresetPlan {
  const store = cmsStoreOf(usage.options)
  // The GitHub store keeps files in Git. It still needs the Database, for editor sessions.
  const stored = store === "github"
    ? { store, github: githubPlan(usage.options) } satisfies Pick<CmsPresetPlan, "github" | "store">
    : { store, blob: usage.options.blob ?? "default" } satisfies Pick<CmsPresetPlan, "blob" | "store">
  const workspace = usage.options.workspace ?? "content"
  const choices = databases.names.length ? [...databases.names].sort().map(name => JSON.stringify(name)).join(", ") : "none"
  if (usage.options.database !== undefined) {
    if (!databases.names.includes(usage.options.database)) {
      throw cmsRequirementError(usage.file, projectRoot, `option database is ${JSON.stringify(usage.options.database)}, but no Database Definition has that name. Database Definitions: ${choices}.`)
    }
    return { ...usage, ...stored, database: usage.options.database, databaseReason: "option", workspace }
  }
  const resolution = databases.resolveDefault(databases.names)
  // Without a Database Definition the preset adds the `default` Database, so the app needs no database files.
  if (resolution.status === "none") return { ...usage, ...stored, database: "default", databaseReason: "preset", workspace }
  if (resolution.status === "ambiguous") {
    throw cmsRequirementError(usage.file, projectRoot, `it needs one Database, but the app has several and none is named "default": ${choices}. Choose one with extends: [cms, { database: ${JSON.stringify(resolution.names[0])} }].`)
  }
  return { ...usage, ...stored, database: resolution.name, databaseReason: resolution.reason, workspace }
}

function githubPlan(options: CmsPresetOptions): CmsGitHubPlan {
  return {
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    branch: options.branch ?? cmsGitHubDefaults.branch,
    draftBranch: options.draftBranch ?? cmsGitHubDefaults.draftBranch,
    root: options.root ?? cmsGitHubDefaults.root,
    publish: options.publish ?? cmsGitHubDefaults.publish,
  }
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
  return cmsPresetStoreSync(input, parseAst) !== undefined
}

/** The selected preset store, without executing the Content Definition. */
export function cmsPresetStoreSync(input: { projectRoot: string, serverDirs?: readonly string[] }, parseAst: ParseAst): "blob-database" | "github" | undefined {
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
  if (files.length !== 1) return undefined
  const file = files[0]!
  const source = readFileSync(file, "utf8")
  // Vite asks once per plugin while it filters them, so parse each version of the file once.
  if (lastPresetCheck?.file !== file || lastPresetCheck.source !== source) {
    const usage = readCmsPresetUsage(source, file, root, parseAst)
    lastPresetCheck = { file, source, store: usage ? cmsStoreOf(usage.options) : undefined }
  }
  return lastPresetCheck.store
}

let lastPresetCheck: { file: string, source: string, store: "blob-database" | "github" | undefined } | undefined

/** Import paths that the generated Workspace module uses. */
export interface CmsWorkspaceImports {
  /** Exports `blob`. */
  blob: string
  /** Exports `createBlobDatabaseWorkspaceStore` and `workspaceHistorySchema`. */
  blobDatabase: string
  /** Exports `contentSessionsSchema`, the presence and edit lease table that the preset adds to its Database. */
  contentDatabase?: string
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
 * The generated Workspace Definition module. It only reads the Database registry and creates a lazy store when it
 * loads, so the build can load it to bundle Workspace assets. The GitHub store reads its token on first use.
 */
export function renderCmsWorkspaceModule(plan: CmsPresetPlan, imports: Omit<CmsWorkspaceImports, "databaseDefinition">): string {
  if (plan.store === "github" && plan.github) return renderGitHubWorkspaceModule(plan, plan.github, imports)
  const missing = `[vitehub] The Content cms preset needs Database ${JSON.stringify(plan.database)}, but it is not configured at runtime. Enable database in vitehub() and keep its Database Definition.`
  return [
    "// Generated by @vite-hub/cms for the cms preset in server/content.ts. Do not edit.",
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
    `    blob: blob.store(${JSON.stringify(plan.blob ?? "default")}),`,
    "    database,",
    `    workspace: ${JSON.stringify(plan.workspace)},`,
    "  }),",
    "})",
    "",
  ].join("\n")
}

function renderGitHubWorkspaceModule(plan: CmsPresetPlan, github: CmsGitHubPlan, imports: Omit<CmsWorkspaceImports, "databaseDefinition">): string {
  return [
    "// Generated by @vite-hub/cms for the cms preset in server/content.ts. Do not edit.",
    `import { useDatabase } from ${JSON.stringify(imports.database)}`,
    `import { defineWorkspace } from ${JSON.stringify(imports.workspace)}`,
    "",
    "// The Database holds editor sessions only. Documents and their history live in the repository.",
    `const database = useDatabase(${JSON.stringify(plan.database)})?.db`,
    "",
    `export const ${cmsWorkspaceExport} = defineWorkspace({`,
    "  store: {",
    '    provider: "github",',
    ...(github.repo ? [`    repository: ${JSON.stringify(github.repo)},`] : []),
    `    branch: ${JSON.stringify(github.branch)},`,
    `    root: ${JSON.stringify(github.root)},`,
    `    refs: { published: ${JSON.stringify(github.branch)}, draft: ${JSON.stringify(github.draftBranch)} },`,
    "    database,",
    "  },",
    // The Workspace can reach the whole folder, and at the repository root the whole repository. Content allows its collection globs on top of this rule.
    '  rules: { "**": { write: false } },',
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
    "// Generated by @vite-hub/cms for the cms preset in server/content.ts. Do not edit.",
    "// The app has no Database Definition, so the preset adds the `default` Database. Its migrations live in",
    "// server/databases/migrations. Add server/databases/config.ts to define the Database yourself.",
    `import { defineDatabase } from ${JSON.stringify(imports.databaseDefinition)}`,
    "",
    "export default defineDatabase({ schema: {} })",
    "",
  ].join("\n")
}
