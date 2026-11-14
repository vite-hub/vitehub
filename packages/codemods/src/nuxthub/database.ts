import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, end, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { moduleSource } from "../shared/module-source.ts"

import type { File } from "@babel/types"
import type { CodeStyle } from "@vite-hub/internal/ast"
import type { FileEdit, FollowUp } from "../types.ts"
import type { Dialect } from "./config.ts"

const scriptExtension = /\.(?:ts|mts|js|mjs)$/
const definitionFile = "server/databases/default/index.ts"

export interface SchemaMove {
  /** Old path of each moved file, by new path. */
  moved: Map<string, string>
  /** The module that holds the schema now, without extension, such as `server/databases/default/schema`. */
  schemaModule?: string
  /** Old schema module, without extension, such as `server/db/schema`. */
  oldModule?: string
  edits: FileEdit[]
  followUps: FollowUp[]
}

/** Every relative import or export source in a module, with the node that holds it. */
function relativeSources(program: File): Array<{ value: string, from: number, to: number, line: number }> {
  const sources: Array<{ value: string, from: number, to: number, line: number }> = []
  walk(program, (node) => {
    const source = moduleSource(node)
    if (source?.value.startsWith(".")) sources.push({ value: source.value, from: start(source) + 1, to: end(source) - 1, line: line(source) })
  })
  return sources
}

/** Finds the file that a relative import names, among `files`. */
function resolveIn(files: ReadonlySet<string>, from: string, specifier: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  const stripped = base.replace(scriptExtension, "")
  for (const candidate of [base, ...["ts", "mts", "js", "mjs"].map(extension => `${stripped}.${extension}`), ...["ts", "mts", "js", "mjs"].map(extension => `${stripped}/index.${extension}`)]) {
    if (files.has(candidate)) return candidate
  }
  return undefined
}

export function relativeSpecifier(fromFile: string, toModule: string): string {
  const path = posix.relative(posix.dirname(fromFile), toModule)
  return path.startsWith(".") ? path : `./${path}`
}

/** Finds the NuxtHub schema: `server/db/schema.ts`, `server/db/schema.<dialect>.ts`, or a `server/db/schema/` folder. */
async function findSchema(cwd: string, dialect: Dialect): Promise<{ files: string[], folder: boolean, others: string[] }> {
  const single = await glob(["server/db/schema.{ts,mts,js,mjs}", "server/db/schema.*.{ts,mts,js,mjs}"], { cwd })
  const plain = single.filter(file => /^server\/db\/schema\.(?:ts|mts|js|mjs)$/.test(file))
  const dialectFiles = single.filter(file => file.startsWith(`server/db/schema.${dialect}.`))
  const folder = (await glob(["server/db/schema/**/*.{ts,mts,js,mjs}"], { cwd })).sort()
  if (folder.length) return { files: folder, folder: true, others: [...single] }
  const chosen = plain[0] ?? dialectFiles[0]
  return { files: chosen ? [chosen] : [], folder: false, others: single.filter(file => file !== chosen) }
}

/**
 * NuxtHub connects a SQLite app to Turso when `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set, with no config. A
 * ViteHub Definition reads only its `connection`, so the codemod names the variables when an env file of the app sets
 * both. It reads only the variable names.
 */
async function usesTursoVariables(cwd: string): Promise<boolean> {
  const names = new Set<string>()
  for (const file of await glob([".env", ".env.*"], { cwd, dot: true })) {
    const code = await readFile(join(cwd, file), "utf8")
    for (const match of code.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm)) names.add(match[1]!)
  }
  return names.has("TURSO_DATABASE_URL") && names.has("TURSO_AUTH_TOKEN")
}

/**
 * Moves the NuxtHub schema to `server/databases/default/` and writes the Database Definition. Relative imports in the
 * moved files are rewritten when they point outside the moved set.
 */
export async function moveSchema(cwd: string, dialect: Dialect): Promise<SchemaMove> {
  const result: SchemaMove = { moved: new Map(), edits: [], followUps: [] }
  const schema = await findSchema(cwd, dialect)
  for (const other of schema.others) {
    result.followUps.push({ file: other, message: `The codemod moved the ${dialect} schema only and left this file. Move it to server/databases/default/ by hand if the app uses it.` })
  }
  if (!schema.files.length) {
    result.followUps.push({ file: "server/db", message: `The codemod found no schema in server/db/. Write the Drizzle tables in a Database Definition at ${definitionFile} with defineDatabase({ schema }) from "vite-hub/database".` })
    return result
  }
  const [existingDefinition] = await glob(["server/databases/default.{ts,mts,js,mjs}", "server/databases/default/index.{ts,mts,js,mjs}"], { cwd })
  if (existingDefinition) {
    result.followUps.push({ file: existingDefinition, message: `${existingDefinition} already exists, so the codemod did not move the schema in ${schema.files.join(", ")}. Add its tables to this Definition by hand.` })
    return result
  }
  const targetOf = (file: string) => schema.folder
    ? file.replace(/^server\/db\/schema\//, "server/databases/default/schema/")
    : file.replace(/^server\/db\/schema(?:\.\w+)?\.(\w+)$/, "server/databases/default/schema.$1")
  const targets = schema.files.map(targetOf)
  const taken = targets.find(target => existsSync(join(cwd, target)))
  if (taken) {
    result.followUps.push({ file: taken, message: `${taken} already exists, so the codemod did not move the schema. Move it to server/databases/default/ and write ${definitionFile} by hand.` })
    return result
  }
  const oldFiles = new Set(schema.files)
  const allFiles = new Set(await glob(["**/*.{ts,mts,js,mjs}"], { cwd, ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**"] }))
  let style: CodeStyle = { quote: "\"", semicolons: false, indent: "  " }
  for (const [index, file] of schema.files.entries()) {
    const target = targets[index]!
    const code = await readFile(join(cwd, file), "utf8")
    const output = new MagicString(code)
    try {
      const program = parseProgram(code, { typescript: !/\.m?js$/.test(file) })
      if (index === 0) style = detectStyle(code, program)
      walk(program, (node) => {
        if (node.type !== "ImportDeclaration" || !["drizzle-orm", "drizzle-orm/relations"].includes(node.source.value)) return
        if (!node.specifiers.some(specifier => specifier.type === "ImportSpecifier" && keyName(specifier.imported) === "relations")) return
        result.followUps.push({ file: target, line: line(node), message: `Drizzle 1.0 replaces relations() with defineRelations(schema, r => ({ ... })). Rewrite these relations, pass the result as relations to defineDatabase() in ${definitionFile}, and update db.query calls to Drizzle 1.0's relational query syntax.` })
      })
      for (const source of relativeSources(program)) {
        const resolved = resolveIn(allFiles, file, source.value)
        if (!resolved) {
          result.followUps.push({ file: target, line: source.line, message: `The codemod cannot find "${source.value}". Check this import after the move from ${file}.` })
          continue
        }
        if (oldFiles.has(resolved)) continue
        const extension = scriptExtension.exec(source.value)?.[0] ?? ""
        const module = extension ? resolved : resolved.replace(scriptExtension, "").replace(/\/index$/, "")
        const moved = relativeSpecifier(target, module)
        if (moved !== source.value) output.overwrite(source.from, source.to, moved)
      }
    }
    catch {
      result.followUps.push({ file: target, message: `The codemod could not parse this schema file, so it did not check its relative imports after the move from ${file}.` })
    }
    result.edits.push({ path: file, before: code, after: null }, { path: target, before: undefined, after: output.toString() })
    result.moved.set(target, file)
  }
  const extension = /\.m?js$/.test(schema.files[0]!) ? "js" : "ts"
  if (schema.folder) {
    result.schemaModule = "server/databases/default/schema"
    result.oldModule = "server/db/schema"
    const existingIndex = targets.find(target => /^server\/databases\/default\/schema\/index\.\w+$/.test(target))
    const aggregate = existingIndex ? `server/databases/default/schema.${extension}` : `server/databases/default/schema/index.${extension}`
    if (existsSync(join(cwd, aggregate))) {
      // No files have been written: abort the plan rather than overwrite a user's module.
      return { moved: new Map(), edits: [], followUps: [{ file: aggregate, message: "The aggregate schema module already exists. Combine every server/db/schema/ module there by hand before moving the schema." }] }
    }
    const exports = targets.map(target => `export * from ${quoteString(relativeSpecifier(aggregate, target.replace(scriptExtension, "")), style)}${style.semicolons ? ";" : ""}`)
    result.edits.push({ path: aggregate, before: undefined, after: `${exports.join("\n")}\n` })
    if (existingIndex) result.followUps.push({ file: aggregate, message: "The aggregate exports every discovered schema file, including the existing index. Check for conflicting export names and resolve any ambiguity before generating the baseline." })
  }
  else {
    result.schemaModule = "server/databases/default/schema"
    result.oldModule = schema.files[0]!.replace(scriptExtension, "")
  }
  const semicolon = style.semicolons ? ";" : ""
  const turso = dialect === "sqlite" && await usesTursoVariables(cwd)
  if (turso) result.followUps.push({ file: definitionFile, message: "An env file of the app sets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, which NuxtHub read on its own. The codemod set connection to these variables. Without them, the Database uses the local SQLite file." })
  const definition = [
    `import { defineDatabase } from ${quoteString("vite-hub/database", style)}${semicolon}`,
    `import * as schema from ${quoteString("./schema", style)}${semicolon}`,
    "",
    "export default defineDatabase({",
    ...(dialect === "postgresql" ? [`${style.indent}dialect: ${quoteString("postgresql", style)},`] : []),
    ...(turso
      ? [
          `${style.indent}connection: {`,
          `${style.indent}${style.indent}url: process.env.TURSO_DATABASE_URL || undefined,`,
          `${style.indent}${style.indent}authToken: process.env.TURSO_AUTH_TOKEN,`,
          `${style.indent}},`,
        ]
      : []),
    `${style.indent}schema,`,
    `})${semicolon}`,
    "",
  ].join("\n")
  result.edits.push({ path: definitionFile, before: undefined, after: definition })
  return result
}
