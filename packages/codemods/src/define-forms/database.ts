import { posix } from "node:path"

import { end, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"

import { followUpAt, parseSource } from "./shared.ts"

import type { FollowUp } from "../types.ts"
import type { SourceFile } from "./shared.ts"

const configFile = /^config\.(?:c|m)?[jt]s$/
const indexFile = /^index\.(?:c|m)?[jt]s$/
const scriptFile = /\.(?:c|m)?[jt]sx?$/
const declarationFile = /\.d\.(?:c|m)?ts$/
/** Calls whose first argument names a module, such as `vi.mock("../databases/config")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

export interface DatabasePlan {
  /** Project path of each file that moves, to its new path. */
  files: Map<string, string>
  /** Project path of each folder that moves, to its new path, such as `server/databases/migrations`. */
  folders: Map<string, string>
  followUps: FollowUp[]
  notes: string[]
}

function folderOf(path: string): string {
  const folder = posix.dirname(path)
  return folder === "." ? "" : folder
}

/** The `server/databases` folder that holds `path`, or undefined. */
function databasesRoot(path: string): string | undefined {
  const match = /^(?:(.*)\/)?server\/databases\//.exec(path)
  if (!match) return undefined
  return match[1] ? `${match[1]}/server/databases` : "server/databases"
}

/**
 * Plans the moves from `config.ts` to the new Database Definition files:
 * - `server/databases/config.ts` was the `default` Database. Every file of `server/databases/` moves to
 *   `server/databases/default/`, and `config.ts` becomes `index.ts`. Relative imports between them keep working.
 * - `server/databases/<name>/config.ts` becomes `server/databases/<name>/index.ts`.
 * - Without a Definition, the migrations of the implicit default Database move to `server/databases/default/migrations/`.
 */
export function planDatabaseMoves(paths: readonly string[], isDefinition: (path: string) => boolean): DatabasePlan {
  const plan: DatabasePlan = { files: new Map(), folders: new Map(), followUps: [], notes: [] }
  const roots = new Map<string, string[]>()
  for (const path of paths) {
    const root = databasesRoot(path)
    if (root) roots.set(root, [...roots.get(root) ?? [], path])
  }
  for (const [root, files] of roots) {
    const relativeFiles = files.map(path => path.slice(root.length + 1))
    const rootConfig = relativeFiles.find(path => configFile.test(path))
    const hasIndex = (folder: string) => relativeFiles.some(path => folderOf(path) === folder && indexFile.test(posix.basename(path)))
    const namedConfigs = relativeFiles.filter(path => path.includes("/") && configFile.test(posix.basename(path)) && !hasIndex(folderOf(path)))
    if (rootConfig) {
      if (relativeFiles.some(path => path.startsWith("default/"))) {
        plan.followUps.push({ file: `${root}/${rootConfig}`, message: `\`${root}/default/\` already exists. Move \`${rootConfig}\` to \`${root}/default/index.ts\` and its migrations to \`${root}/default/migrations/\` by hand.` })
        continue
      }
      if (namedConfigs.length) {
        plan.followUps.push({ file: `${root}/${rootConfig}`, message: `This app mixes the default Database with named ones (${namedConfigs.map(path => `\`${path}\``).join(", ")}). Move each \`config.ts\` to \`<name>/index.ts\` by hand.` })
        continue
      }
      for (const path of relativeFiles) {
        plan.files.set(`${root}/${path}`, `${root}/default/${path === rootConfig ? rootConfig.replace(/^config/, "index") : path}`)
      }
      for (const folder of new Set(relativeFiles.map(folderOf).filter(Boolean))) {
        for (let current = folder; current; current = folderOf(current)) plan.folders.set(`${root}/${current}`, `${root}/default/${current}`)
      }
      plan.notes.push(`\`${root}/config.ts\` was the \`default\` Database. It is now \`${root}/default/index.ts\`, and the files beside it moved with it.`)
      continue
    }
    for (const path of namedConfigs) {
      plan.files.set(`${root}/${path}`, `${root}/${folderOf(path)}/${posix.basename(path).replace(/^config/, "index")}`)
    }
    const definitions = relativeFiles.filter(path => scriptFile.test(path) && !declarationFile.test(path) && !path.startsWith("migrations/"))
    const migrations = relativeFiles.filter(path => path.startsWith("migrations/"))
    if (migrations.length && !definitions.length && !relativeFiles.some(path => path.startsWith("default/"))) {
      for (const path of migrations) plan.files.set(`${root}/${path}`, `${root}/default/${path}`)
      for (const folder of new Set(migrations.map(folderOf))) {
        for (let current = folder; current; current = folderOf(current)) plan.folders.set(`${root}/${current}`, `${root}/default/${current}`)
      }
      plan.notes.push(`The migrations of the implicit default Database moved from \`${root}/migrations/\` to \`${root}/default/migrations/\`.`)
    }
  }
  plan.followUps.push(...strayDefinitions(paths, plan, isDefinition))
  return plan
}

/**
 * Source files that the new discovery reads as Database Definitions but that were helpers before, such as
 * `server/databases/shared.ts` beside named Databases. A folder with an `index.ts` is one Database, so helpers belong
 * in it.
 */
function strayDefinitions(paths: readonly string[], plan: DatabasePlan, isDefinition: (path: string) => boolean): FollowUp[] {
  const final = paths.filter(path => !isDefinition(path)).map(path => plan.files.get(path) ?? path)
  const indexFolders = new Set(paths.map(path => plan.files.get(path) ?? path).filter(path => indexFile.test(posix.basename(path)) && databasesRoot(path)).map(folderOf))
  const followUps: FollowUp[] = []
  for (const path of final) {
    const root = databasesRoot(path)
    if (!root || !scriptFile.test(path) || declarationFile.test(path) || indexFile.test(posix.basename(path))) continue
    let inside = false
    for (let folder = folderOf(path); folder.length > root.length; folder = folderOf(folder)) {
      if (indexFolders.has(folder)) inside = true
    }
    if (inside) continue
    const name = path.slice(root.length + 1).replace(scriptFile, "")
    followUps.push({ file: path, message: `ViteHub now reads this file as the Database Definition \`${name}\`. Move a helper into the folder of the Database that uses it, next to its \`index.ts\`.` })
  }
  return followUps
}

/** The project path without extension that an import path names, for relative paths and Nuxt and Vite aliases. */
function resolveSpecifier(from: string, specifier: string): { base: string, alias?: string, path: string } | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return { base: folderOf(from), path: posix.normalize(posix.join(folderOf(from), specifier)) }
  }
  const match = /^(~~|@@|#server)\/(.*)$/.exec(specifier)
  if (!match) return undefined
  const [, alias = "", rest = ""] = match
  return alias === "#server" ? { alias, base: "server", path: posix.join("server", rest) } : { alias, base: "", path: posix.normalize(rest) }
}

const extensionPattern = /\.(?:c|m)?[jt]sx?$/

/** Builds the lookup from an import target, with or without extension, to its moved path. */
function moveIndex(plan: DatabasePlan) {
  const byPath = new Map<string, string>()
  for (const [from, to] of plan.files) {
    byPath.set(from, to)
    if (extensionPattern.test(from)) byPath.set(from.replace(extensionPattern, ""), to.replace(extensionPattern, ""))
  }
  return byPath
}

function relativeSpecifier(fromFolder: string, target: string): string {
  const path = posix.relative(fromFolder, target) || "."
  return path.startsWith(".") ? path : `./${path}`
}

/** The new import path of `specifier` in `file`, which moves to `newFile`. Undefined when it stays the same. */
function rewriteSpecifier(file: string, newFile: string, specifier: string, moves: ReadonlyMap<string, string>): string | undefined {
  const resolved = resolveSpecifier(file, specifier)
  if (!resolved) return undefined
  // `./drops.js` can name `drops.ts`, so a path with an extension also matches the moved path without one.
  const extension = extensionPattern.exec(resolved.path)?.[0]
  const withoutExtension = extension ? moves.get(resolved.path.slice(0, -extension.length)) : undefined
  const target = moves.get(resolved.path) ?? (withoutExtension === undefined ? resolved.path : `${withoutExtension}${extension}`)
  if (resolved.alias) {
    if (target === resolved.path) return undefined
    return `${resolved.alias}/${resolved.alias === "#server" ? posix.relative("server", target) : target}`
  }
  if (target === resolved.path && file === newFile) return undefined
  const next = relativeSpecifier(folderOf(newFile), target)
  return next === specifier ? undefined : next
}

/** Rewrites the import paths and path strings of one file for the planned moves. */
export function rewriteDatabaseReferences(file: SourceFile, plan: DatabasePlan, followUps: FollowUp[]): string {
  const newPath = plan.files.get(file.path) ?? file.path
  const parsed = parseSource(file)
  if (!("program" in parsed)) {
    followUps.push(parsed)
    return file.code
  }
  const moves = moveIndex(plan)
  const output = new MagicString(file.code)
  const sources = new Set<unknown>()
  const replace = (node: { value: string }) => {
    const next = rewriteSpecifier(file.path, newPath, node.value, moves)
    if (next === undefined) return
    const literal = node as unknown as Parameters<typeof start>[0]
    const quote = file.code[start(literal)] ?? "\""
    output.overwrite(start(literal), end(literal), `${quote}${next}${quote}`)
  }
  walk(parsed.program, (node) => {
    let source: unknown
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && node.source) source = node.source
    else if (node.type === "ImportExpression") source = node.source
    else if (node.type === "CallExpression" && node.callee.type === "Import") source = node.arguments[0]
    else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") source = node.arguments[0]
    else if (node.type === "TSExternalModuleReference") source = node.expression
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier" && moduleCalls.has(node.callee.property.name)) source = node.arguments[0]
    else if (node.type === "TSImportType") source = node.argument
    if (source && typeof source === "object" && "type" in source && source.type === "StringLiteral" && "value" in source && typeof source.value === "string") {
      sources.add(source)
      replace(source as { value: string })
    }
  })
  // Paths in config, such as `out: "./server/databases/migrations"` in drizzle.config.ts.
  walk(parsed.program, (node) => {
    if (node.type !== "StringLiteral" || sources.has(node)) return
    const raw = node.value
    const prefix = raw.startsWith("./") ? "./" : ""
    const path = raw.slice(prefix.length).replace(/\/$/, "")
    const moved = plan.files.get(path) ?? plan.folders.get(path)
    if (moved) {
      const quote = file.code[start(node)] ?? "\""
      output.overwrite(start(node), end(node), `${quote}${prefix}${moved}${raw.endsWith("/") ? "/" : ""}${quote}`)
      return
    }
    if (/server\/databases\/(?:.*\/)?(?:config|migrations)\b/.test(raw)) {
      followUps.push(followUpAt(newPath, node, `This string names \`${raw}\`. Database Definitions moved from \`config.ts\` to \`<name>/index.ts\`, with migrations in \`<name>/migrations/\`. Update it by hand if it names a moved file.`))
    }
  })
  return output.toString()
}
