import { readFile } from "node:fs/promises"

import { findContentEntry } from "@vite-hub/source/vite"

import type { ViteHubConsoleDocumentEditorSection } from "@vite-hub/internal/console"

export interface ContentConsoleOptions {
  projectRoot: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
}

type Node = Record<string, unknown> & { type?: unknown }

const contentModules: ReadonlySet<string> = new Set(["vite-hub/content", "@vite-hub/content"])

function isNode(value: unknown): value is Node {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.filter(isNode) : []
}

function name(node: unknown): string | undefined {
  if (!isNode(node)) return
  if (node.type === "Identifier" && String(node.name) === node.name) return node.name
  if (node.type === "Literal" && String(node.value) === node.value) return node.value
}

/** Drops `as`, `satisfies`, `!`, and parentheses around an expression. */
function unwrap(node: unknown): unknown {
  let current = node
  while (isNode(current) && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(current.type))) {
    current = current.expression
  }
  return current
}

/**
 * Whether a Content module may define document collections. It reads the `defineContent()` call that initializes the
 * `content` export and answers false only when it can tell that the call has no non-empty `collections` object.
 * Anything it cannot follow, such as options built by a function or imported from another file, counts as maybe.
 */
function contentModuleDefinesCollections(program: unknown): boolean {
  const body = isNode(program) ? nodes(program.body) : []
  const constants = new Map<string, unknown>()
  const defineContentNames = new Set<string>()
  let contentInit: unknown
  let contentLocal: string | undefined
  for (const statement of body) {
    if (statement.type === "ImportDeclaration" && isNode(statement.source) && contentModules.has(String(statement.source.value))) {
      for (const specifier of nodes(statement.specifiers)) {
        if (specifier.type === "ImportSpecifier" && name(specifier.imported) === "defineContent") {
          const local = name(specifier.local)
          if (local) defineContentNames.add(local)
        }
      }
    }
    const exported = statement.type === "ExportNamedDeclaration"
    const declaration = exported ? statement.declaration : statement
    if (isNode(declaration) && declaration.type === "VariableDeclaration") {
      for (const declarator of nodes(declaration.declarations)) {
        const local = name(declarator.id)
        if (!local) continue
        if (declaration.kind === "const") constants.set(local, declarator.init)
        if (exported && local === "content") contentInit = declarator.init
      }
    }
    if (exported && !statement.source) {
      for (const specifier of nodes(statement.specifiers)) {
        if (name(specifier.exported) === "content") contentLocal = name(specifier.local)
      }
    }
  }
  if (contentInit === undefined && contentLocal) contentInit = constants.get(contentLocal)
  const resolve = (node: unknown): unknown => {
    const value = unwrap(node)
    const local = isNode(value) && value.type === "Identifier" ? name(value) : undefined
    return local && constants.has(local) ? unwrap(constants.get(local)) : value
  }

  const call = unwrap(contentInit)
  if (!isNode(call) || call.type !== "CallExpression") return true
  const callee = name(unwrap(call.callee))
  if (!callee || !defineContentNames.has(callee)) return true
  const [argument, ...rest] = Array.isArray(call.arguments) ? call.arguments : []
  if (argument === undefined) return false
  const options = resolve(argument)
  if (rest.length || !isNode(options) || options.type !== "ObjectExpression") return true
  let collections: unknown
  for (const property of Array.isArray(options.properties) ? options.properties : []) {
    if (!isNode(property) || property.type !== "Property") return true
    if (!property.computed && name(property.key) === "collections") collections = property.value
  }
  if (collections === undefined) return false
  const value = resolve(collections)
  if (!isNode(value) || value.type !== "ObjectExpression") return true
  return Array.isArray(value.properties) && value.properties.length > 0
}

/** Finds the Content module of the project, but only when it may define document collections. */
async function findContentCollectionsEntry(options: ContentConsoleOptions): Promise<string | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  // `vite` is an optional peer. The Console discovers sections inside Vite, so it is installed there.
  const { parseAst } = await import("vite")
  let program: unknown
  try {
    program = parseAst(await readFile(file, "utf8"), { lang: /\.[cm]?ts$/.test(file) ? "ts" : "js" })
  }
  catch {
    // The runtime reports the syntax error. Keep the section so the editor shows it.
    return file
  }
  return contentModuleDefinesCollections(program) ? file : undefined
}

/**
 * Console section for Content. It edits the document collections of the `content` export of `server/content.ts`.
 * Every action checks `content.can()` with the signed-in Console user. The Console shows the section only when
 * `defineContent()` defines document collections; a Content file with only read-only Sources has nothing to edit.
 */
export const contentConsoleSection: ViteHubConsoleDocumentEditorSection<ContentConsoleOptions> = {
  actions: { export: "createContentConsoleActions", module: "@vite-hub/content/runtime/console" },
  description: "Edit, publish, and restore Content documents.",
  entry: options => findContentCollectionsEntry(options),
  icon: "i-lucide-file-pen-line",
  id: "content",
  label: "Content",
  pages: [
    { id: "dashboard", label: "Dashboard", icon: "i-lucide-layout-dashboard", index: true, view: { kind: "document-dashboard" } },
    { id: "settings", label: "Settings", icon: "i-lucide-settings-2", group: "Site", view: { kind: "document-settings" } },
    { id: "media", label: "Media", icon: "i-lucide-image", group: "Assets", requires: ["blob"], view: { kind: "media-library" } },
  ],
  view: {
    kind: "document-editor",
    notice: "Saves commit to the draft ref of the Content Workspace. Publishing copies documents to the published ref, which /api/content serves. content.can() decides what each user may read, write, and publish.",
  },
}
