import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, isReference, line, parseProgram, walk } from "@vite-hub/internal/ast"
import { glob } from "tinyglobby"

import type { File, ImportDeclaration } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"

export const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
export const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/.vitehub-migrate/**", "**/dist/**", "**/coverage/**"]

export interface SourceFile {
  /** Path relative to the project directory, with `/` separators. */
  path: string
  code: string
}

/** Every source file of the project, sorted by path. */
export async function readSourceFiles(cwd: string): Promise<SourceFile[]> {
  const paths = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  return await Promise.all(paths.map(async path => ({ path, code: await readFile(join(cwd, path), "utf8") })))
}

export interface ParsedFile {
  program: File
  style: CodeStyle
}

/** Parses a source file. Returns a follow-up instead when the file does not parse. */
export function parseSource(file: SourceFile): ParsedFile | FollowUp {
  try {
    const program = parseProgram(file.code, { jsx: /\.[jt]sx$/.test(file.path), typescript: !/\.(?:c|m)?jsx?$/.test(file.path) })
    return { program, style: detectStyle(file.code, program) }
  }
  catch (error) {
    return { file: file.path, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Update it by hand.` }
  }
}

export function followUpAt(file: string, node: Node, message: string): FollowUp {
  return { file, line: line(node), message }
}

export function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

/**
 * The local names of a ViteHub define function in `program`. A name imported from one of `modules` counts. Without
 * an import of the name, a call of the bare name counts too, because Nuxt auto-imports the define functions.
 */
export function defineFunctionNames(program: File, name: string, modules: ReadonlySet<string>): Set<string> {
  const names = new Set<string>()
  let importedElsewhere = false
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    for (const specifier of statement.specifiers) {
      if (modules.has(statement.source.value) && importedName(specifier) === name) names.add(specifier.local.name)
      else if (specifier.local.name === name) importedElsewhere = true
    }
  }
  if (!names.size && !importedElsewhere && !declares(program, name)) names.add(name)
  return names
}

/** True when `program` declares `name` as a function, class, or variable. */
function declares(program: File, name: string): boolean {
  let found = false
  walk(program, (node) => {
    if (found) return
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.name === name) found = true
    else if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === name) found = true
  })
  return found
}

/** Counts the reads of `name` in `program`, outside import and export specifiers. */
export function countReferences(program: File, name: string): number {
  let count = 0
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (parent?.type === "ExportSpecifier") return
    if (isReference(node, parent) && node.name === name) count++
  })
  return count
}
