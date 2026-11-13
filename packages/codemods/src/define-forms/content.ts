import { posix } from "node:path"

import { end, start, walk } from "@vite-hub/internal/ast"

import { countReferences, followUpAt, importedName } from "./shared.ts"

import type { ExportNamedDeclaration } from "@babel/types"
import type MagicString from "magic-string"
import type { FollowUp } from "../types.ts"
import type { ParsedFile, SourceFile } from "./shared.ts"

/** `server/content.ts` of the app or of a Nuxt layer. */
export const contentFilePattern = /(?:^|\/)server\/content\.(?:c|m)?[jt]s$/

function exportedName(specifier: ExportNamedDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ExportSpecifier") return undefined
  return specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
}

/**
 * Turns the `content` export of `server/content.ts` into the default export. Returns true when it changed the file,
 * and false when the file has no `content` export or needs a manual conversion.
 */
export function rewriteContentFile(file: SourceFile, parsed: ParsedFile, output: MagicString, followUps: FollowUp[]): boolean {
  const { program } = parsed
  const hasDefault = program.program.body.some(statement => statement.type === "ExportDefaultDeclaration"
    || (statement.type === "ExportNamedDeclaration" && statement.specifiers.some(specifier => exportedName(specifier) === "default")))
  for (const statement of program.program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue
    const declaration = statement.declaration
    const declarator = declaration?.type === "VariableDeclaration"
      ? declaration.declarations.find(item => item.id.type === "Identifier" && item.id.name === "content")
      : undefined
    const specifier = statement.specifiers.find(item => exportedName(item) === "content")
    if (!declarator && !specifier) continue
    if (hasDefault) {
      followUps.push(followUpAt(file.path, statement, "This file already has a default export. Make the named `content` runtime its default export and update its consumers by hand."))
      return false
    }
    if (declaration?.type === "VariableDeclaration") {
      if (!declarator) continue
      if (declaration.declarations.length > 1 || !declarator.init) {
        followUps.push(followUpAt(file.path, statement, "Export the `defineContent()` result of this file as the default export by hand."))
        return false
      }
      // `export const content = defineContent()` becomes `export default defineContent()`. When the file reads
      // `content` itself, it keeps the constant and exports it.
      if (countReferences(program, "content") === 0) {
        output.overwrite(start(statement), start(declarator.init), "export default ")
      }
      else {
        output.remove(start(statement), start(declaration))
        output.appendLeft(end(statement), `\nexport default content${parsed.style.semicolons ? ";" : ""}`)
      }
      return true
    }
    if (!specifier || specifier.type !== "ExportSpecifier") continue
    if (!statement.source && statement.specifiers.length === 1 && specifier.local.type === "Identifier" && specifier.local.name === "content") {
      output.overwrite(start(statement), end(statement), `export default content${parsed.style.semicolons ? ";" : ""}`)
    }
    else {
      // `export { content }` has one name for both sides, and `export { runtime as content }` has two.
      const sameName = start(specifier.local) === start(specifier.exported)
      output.overwrite(start(specifier.exported), end(specifier.exported), sameName ? "content as default" : "default")
    }
    return true
  }
  return false
}

/** Resolves an import path to a project path without extension, for the aliases that Nuxt and Vite apps use. */
function resolveImport(from: string, specifier: string): string[] {
  const strip = (path: string) => posix.normalize(path).replace(/\.(?:c|m)?[jt]s$/, "")
  if (specifier.startsWith("./") || specifier.startsWith("../")) return [strip(posix.join(posix.dirname(from), specifier))]
  const alias = /^(~~|@@|~|@|#server)\/(.*)$/.exec(specifier)
  if (!alias) return []
  const [, prefix, rest = ""] = alias
  if (prefix === "#server") return [strip(posix.join("server", rest))]
  // `~` and `@` point at the source directory, which is the root in Vite and `app/` in Nuxt 4 and later.
  return prefix === "~" || prefix === "@" ? [strip(rest), strip(posix.join("app", rest))] : [strip(rest)]
}

/** Rewrites `import { content } from "<server/content.ts>"` to a default import. */
export function rewriteContentImports(file: SourceFile, parsed: ParsedFile, contentFiles: ReadonlySet<string>, output: MagicString, followUps: FollowUp[]): number {
  if (!file.code.includes("content")) return 0
  const targets = new Set([...contentFiles].map(path => path.replace(/\.(?:c|m)?[jt]s$/, "")))
  const pointsAtContent = (specifier: string) => resolveImport(file.path, specifier).some(path => targets.has(path))
  let count = 0
  for (const statement of parsed.program.program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.source && pointsAtContent(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ExportSpecifier" && specifier.local.type === "Identifier" && specifier.local.name === "content") {
          output.overwrite(start(specifier.local), end(specifier.local), "default")
          if (start(specifier.local) === start(specifier.exported)) output.appendLeft(end(specifier.local), " as content")
          count++
        }
      }
      continue
    }
    if (statement.type !== "ImportDeclaration" || !pointsAtContent(statement.source.value)) continue
    const specifier = statement.specifiers.find(item => importedName(item) === "content")
    if (!specifier) continue
    const local = specifier.local.name
    const others = statement.specifiers.filter(item => item !== specifier)
    if (others.some(item => item.type !== "ImportSpecifier")) {
      followUps.push(followUpAt(file.path, statement, "Import the default export of `server/content.ts` instead of `content` by hand."))
      continue
    }
    const typeOnly = statement.importKind === "type" ? "type " : ""
    const named = others.map(item => file.code.slice(start(item), end(item)))
    const source = file.code.slice(start(statement.source), end(statement.source))
    const semicolon = file.code[end(statement) - 1] === ";" ? ";" : ""
    output.overwrite(start(statement), end(statement), `import ${typeOnly}${local}${named.length ? `, { ${named.join(", ")} }` : ""} from ${source}${semicolon}`)
    count++
  }
  walk(parsed.program, (node) => {
    const source = node.type === "ImportExpression" ? node.source : node.type === "CallExpression" && node.callee.type === "Import" ? node.arguments[0] : undefined
    if (source?.type === "StringLiteral" && pointsAtContent(source.value)) {
      followUps.push(followUpAt(file.path, node, "This dynamic import loads `server/content.ts`. Read its `default` export instead of `content`."))
    }
  })
  return count
}
