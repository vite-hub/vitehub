import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { parseProgram, walk } from "@vite-hub/internal/ast"

import type { File, ObjectExpression } from "@babel/types"

const extensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]

function resolveRelativeImport(cwd: string, importer: string, source: string): string | undefined {
  const base = resolve(cwd, dirname(importer), source)
  const candidates = [base, ...extensions.map(extension => `${base}${extension}`), ...extensions.map(extension => join(base, `index${extension}`))]
  const file = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  if (!file) return
  const path = relative(cwd, file).replaceAll("\\", "/")
  return path.startsWith("..") || isAbsolute(path) || path.includes("node_modules/") ? undefined : path
}

/**
 * The project files that the config files import with a relative path, such as `./build/host-profile.ts`. An app can
 * build its vite-hub options there and pass them to `vitehub()` or the `vitehub` key of its Nuxt config.
 */
export function configImportedFiles(cwd: string, configFiles: readonly string[]): string[] {
  const imported = new Set<string>()
  for (const file of configFiles) {
    let program: File
    try {
      program = parseProgram(readFileSync(join(cwd, file), "utf8"), { typescript: !/\.(?:c|m)?js$/.test(file) })
    }
    catch {
      continue
    }
    for (const statement of program.program.body) {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !/^\.\.?\//.test(statement.source.value)) continue
      const path = resolveRelativeImport(cwd, file, statement.source.value)
      if (path && !configFiles.includes(path)) imported.add(path)
    }
  }
  return [...imported].sort()
}

/** Each `vitehub: { ... }` key of `program` with an object literal value, and the object that holds the key. */
function vitehubKeys(program: File): Array<{ options: ObjectExpression, parent: ObjectExpression }> {
  const keys: Array<{ options: ObjectExpression, parent: ObjectExpression }> = []
  walk(program, (node, ancestors) => {
    if (node.type !== "ObjectProperty" || node.computed || node.value.type !== "ObjectExpression") return
    const name = node.key.type === "Identifier" ? node.key.name : node.key.type === "StringLiteral" ? node.key.value : undefined
    const parent = ancestors.at(-1)
    if (name === "vitehub" && parent?.type === "ObjectExpression") keys.push({ options: node.value, parent })
  })
  return keys
}

/** The vite-hub options objects of `program`: every object literal that a `vitehub` key holds. */
export function vitehubKeyObjects(program: File): ObjectExpression[] {
  return vitehubKeys(program).map(key => key.options)
}

/** The objects of `program` that hold a `vitehub: { ... }` key, such as the host profile that `nuxt.config.ts` imports. */
export function vitehubKeyParents(program: File): ObjectExpression[] {
  return [...new Set(vitehubKeys(program).map(key => key.parent))]
}
