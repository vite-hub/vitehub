import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"

import { detectStyle, end, isReference, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { blockBindings } from "../shared/bindings.ts"

import type { File, ImportDeclaration } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FileEdit, FollowUp } from "../types.ts"
import type { T3Field } from "./plan.ts"

const serverImport = "vite-hub/env"
const publicImport = "#vitehub/env/public"

/** Where a file runs: `server` code, `app` code in the browser, `shared` code on both, or `outside` the Nuxt runtime. */
export type FileContext = "app" | "outside" | "server" | "shared"

const appFolders = new Set(["app", "pages", "components", "composables", "plugins", "layouts", "middleware"])
const outsideFolders = new Set(["scripts", "script", "test", "tests", "e2e", "bin", "tools"])

export function classify(file: string): FileContext {
  const segments = file.split("/")
  // Local modules belong to the app or layer root. Runtime folders may also be named `modules`.
  let root = 0
  while (segments[root] === "layers" && segments[root + 1] && segments[root + 2]) root += 2
  if (outsideFolders.has(segments[root] ?? "") || segments[root] === "modules" || /^nuxt\.config\.[cm]?[jt]s$/.test(segments.at(-1) ?? "")) return "outside"
  if (segments.includes("server") || /\.server\.[cm]?[jt]sx?$/.test(file)) return "server"
  if (segments.length === 1) return /^(?:app|error)\.vue$/.test(file) ? "app" : "outside"
  if (file.endsWith(".vue") || /\.client\.[cm]?[jt]sx?$/.test(file) || appFolders.has(segments[0] ?? "")) return "app"
  return "shared"
}

/** Strips the extension and a trailing `/index` so that import specifiers and files compare. */
function normalize(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "")
}

/**
 * Resolves a Nuxt import specifier to the paths, relative to the app, that it can point at. `~/` and `@/` point at
 * the source directory, which is `app/` in Nuxt 4 layouts and the app root before, so both are candidates.
 * A package specifier resolves to no path.
 */
export function resolveSpecifier(cwd: string, fromFile: string, specifier: string): string[] {
  let paths: string[] = []
  if (specifier.startsWith(".")) paths = [posix.join(posix.dirname(fromFile), specifier)]
  else if (specifier.startsWith("~~/") || specifier.startsWith("@@/")) paths = [specifier.slice(3)]
  else if (specifier.startsWith("~/") || specifier.startsWith("@/")) paths = [...(existsSync(join(cwd, "app")) ? [`app/${specifier.slice(2)}`] : []), specifier.slice(2)]
  else if (specifier.startsWith("#shared/")) paths = [`shared/${specifier.slice(8)}`]
  else if (specifier.startsWith("#server/")) paths = [`server/${specifier.slice(8)}`]
  return paths.map(path => normalize(posix.normalize(path)))
}

/** True when `specifier` in `fromFile` can point at `file`. */
export function importsFile(cwd: string, fromFile: string, specifier: string, file: string): boolean {
  return resolveSpecifier(cwd, fromFile, specifier).includes(normalize(file))
}

/** Local import specifiers in `code` whose last segment names the same file as `file`. */
export function localSpecifiersNaming(code: string, file: string): string[] {
  const name = posix.basename(normalize(file))
  return [...code.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)]
    .map(match => match[1] ?? "")
    .filter(specifier => /^(?:\.|~|#|@\/|@@\/)/.test(specifier) && posix.basename(normalize(specifier)) === name)
}

interface Block {
  code: string
  offset: number
  lineOffset: number
  typescript: boolean
  jsx: boolean
}

function scriptBlocks(file: string, source: string): { blocks: Block[], template?: string } {
  if (!file.endsWith(".vue")) {
    return { blocks: [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }] }
  }
  const { descriptor } = parseSfc(source, { filename: file })
  const blocks = [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{ code: block.content, offset: block.loc.start.offset, lineOffset: block.loc.start.line - 1, jsx: lang === "tsx" || lang === "jsx", typescript: lang === "ts" || lang === "tsx" }]
  })
  return { blocks, template: descriptor.template?.content }
}

export interface EnvModule {
  /** Path of the env module relative to the app, such as `env.ts`. */
  file: string
  exportName: string
}

export interface CallSiteResult {
  edits: FileEdit[]
  followUps: FollowUp[]
  /** Files that still import the env module after the rewrite. */
  remainingImporters: string[]
}

/**
 * Rewrites `env.KEY` reads in files that import the env module to `useServerEnv().key` and
 * `usePublicEnv().key`. Secret reads call `.unseal()`, so code still receives the raw string.
 */
export async function rewriteT3CallSites(cwd: string, module: EnvModule, fields: readonly T3Field[], skip: readonly string[]): Promise<CallSiteResult> {
  const byKey = new Map(fields.map(entry => [entry.key, entry]))
  const target = normalize(module.file)
  const files = await glob(["**/*.{ts,mts,cts,js,mjs,cjs,tsx,jsx,vue}"], { cwd, ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**", ...skip] })
  const result: CallSiteResult = { edits: [], followUps: [], remainingImporters: [] }
  for (const file of files.sort()) {
    if (file === module.file) continue
    const source = await readFile(join(cwd, file), "utf8")
    if (!source.includes(posix.basename(target))) continue
    const context = classify(file)
    const { blocks, template } = scriptBlocks(file, source)
    const output = new MagicString(source)
    let changed = false
    let keepsImport = false
    for (const block of blocks) {
      let program: File
      try {
        program = parseProgram(block.code, { typescript: block.typescript, jsx: block.jsx })
      }
      catch {
        continue
      }
      const imports = program.program.body.filter((statement): statement is ImportDeclaration => statement.type === "ImportDeclaration"
        && importsFile(cwd, file, statement.source.value, module.file))
      if (!imports.length) continue
      const follow = (node: Node, message: string) => result.followUps.push({ file, line: line(node) + block.lineOffset, message })
      if (context === "outside") {
        follow(imports[0]!, `This file runs outside the Nuxt app or server runtime, so it cannot read Env through #vitehub/env. The codemod kept ${module.file} for it. Read process.env here, then delete ${module.file}.`)
        keepsImport = true
        continue
      }
      const bindings = blockBindings(program)
      const locals = new Map<string, Node>()
      for (const statement of imports) {
        for (const specifier of statement.specifiers) {
          const imported = specifier.type === "ImportSpecifier" ? keyName(specifier.imported) : undefined
          if (imported === module.exportName) {
            if (bindings.get(specifier.local.name)?.some(binding => binding !== specifier.local)) {
              follow(specifier, `Another binding named ${specifier.local.name} shadows the env import. The codemod kept its reads unchanged. Rewrite them by hand with aliased Env imports.`)
              keepsImport = true
            }
            else locals.set(specifier.local.name, specifier)
          }
          else {
            follow(specifier, `This import of ${module.file} is not the createEnv() result. Move it out of ${module.file} before deleting the file.`)
            keepsImport = true
          }
        }
      }
      let needsServer = false
      let needsPublic = false
      const identifiers = new Set<string>()
      walk(program, (node) => {
        if (node.type === "Identifier") identifiers.add(node.name)
      })
      const accessorName = (name: string, alias: string): string => {
        if (!identifiers.has(name)) return name
        let candidate = alias
        let suffix = 2
        while (identifiers.has(candidate)) candidate = `${alias}${suffix++}`
        return candidate
      }
      const serverName = accessorName("useServerEnv", "viteHubServerEnv")
      const publicName = accessorName("usePublicEnv", "viteHubPublicEnv")
      const remaining = new Set<string>()
      for (const [local, specifier] of locals) {
        const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        if (template && new RegExp(`(?:^|[^\\w$])${escaped}(?![\\w$])`).test(template)) {
          follow(specifier, `The template reads ${local}.KEY, which the codemod does not rewrite, so this import stays. Read the values in the script with useServerEnv() or usePublicEnv(), then use them in the template.`)
          remaining.add(local)
        }
      }
      walk(program, (node, ancestors) => {
        if (node.type !== "Identifier" || !locals.has(node.name) || !isReference(node, ancestors.at(-1))) return
        const parent = ancestors.at(-1)
        const member = parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.object === node ? parent : undefined
        const key = member ? keyName(member.property, member.computed) : undefined
        const keep = (message: string) => {
          follow(node, message)
          remaining.add(node.name)
        }
        if (!member || !key) return keep(`This code uses ${node.name} as a value, not as env.KEY. Read each value with useServerEnv() or usePublicEnv() instead.`)
        const grand = ancestors.at(-2)
        if (grand && ((grand.type === "AssignmentExpression" && grand.left === member) || grand.type === "UpdateExpression")) return keep(`This code writes ${node.name}.${key}. Env values are read-only.`)
        const entry = byKey.get(key)
        if (!entry) return keep(`${key} is not declared in ${module.file}, so it was not migrated.`)
        const { field } = entry
        let replacement: string
        if (field.section === "public") {
          replacement = `${publicName}().${field.envPath[0]}`
          needsPublic = true
        }
        else if (context === "app") {
          return keep(`${key} is a server variable, and this file runs in the browser. Move the read to server code.`)
        }
        else {
          const unseal = field.secret ? `${field.required ? "." : "?."}unseal()` : ""
          replacement = `${serverName}().${field.envPath[0]}${unseal}`
          needsServer = true
          if (context === "shared") follow(node, `${key} is Server Env, and this file is outside server/. Import this file only from server code: Server Env is not available in the browser.`)
        }
        output.overwrite(block.offset + start(member), block.offset + end(member), replacement)
        changed = true
      })
      const style = detectStyle(block.code, program)
      const semicolon = style.semicolons ? ";" : ""
      const lines: string[] = []
      if (needsServer) lines.push(`import { ${serverName === "useServerEnv" ? serverName : `useServerEnv as ${serverName}`} } from ${quoteString(serverImport, style)}${semicolon}`)
      if (needsPublic) lines.push(`import { ${publicName === "usePublicEnv" ? publicName : `usePublicEnv as ${publicName}`} } from ${quoteString(publicImport, style)}${semicolon}`)
      let placed = false
      for (const statement of imports) {
        const keptSpecifiers = statement.specifiers.filter(specifier => !locals.has(specifier.local.name) || remaining.has(specifier.local.name))
        if (keptSpecifiers.length) {
          keepsImport = true
          if (keptSpecifiers.length === statement.specifiers.length) continue
          const names = keptSpecifiers.map(specifier => block.code.slice(start(specifier), end(specifier)))
          output.overwrite(block.offset + start(statement), block.offset + end(statement), `import { ${names.join(", ")} } from ${block.code.slice(start(statement.source), end(statement))}`)
          changed = true
          continue
        }
        const from = block.offset + start(statement)
        const to = block.offset + end(statement)
        if (lines.length && !placed) {
          output.overwrite(from, to, lines.join("\n"))
          placed = true
        }
        else {
          output.remove(from, block.code[end(statement)] === "\n" ? to + 1 : to)
        }
        changed = true
      }
      if (lines.length && !placed) {
        const last = program.program.body.filter(statement => statement.type === "ImportDeclaration").at(-1)
        if (last) output.appendLeft(block.offset + end(last), `\n${lines.join("\n")}`)
        else output.prependLeft(block.offset, `${lines.join("\n")}\n`)
      }
    }
    if (keepsImport) result.remainingImporters.push(file)
    if (changed) result.edits.push({ path: file, before: source, after: output.toString() })
  }
  return result
}
