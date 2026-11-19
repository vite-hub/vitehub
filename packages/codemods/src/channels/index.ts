import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, isReference, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { File, Identifier, ImportDeclaration, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** `vite-hub/agent/channels` joined `vite-hub/channels`. The owner path `@vite-hub/agent/channels` stays. */
const movedPath = "vite-hub/agent/channels"
const channelsPath = "vite-hub/channels"

/** Modules that exported `http()`. `http(options)` is now `channelAdapter("http", options)`. */
const httpModules = new Set([movedPath, channelsPath, "@vite-hub/agent/channels"])

/** Calls whose first argument names a module, such as `vi.mock("vite-hub/agent/channels")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /vite-hub\/agent\/channels|\bhttp\b/

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

function scriptBlocks(file: string, source: string): Block[] {
  if (!file.endsWith(".vue")) {
    return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(source, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{
      code: block.content,
      offset: block.loc.start.offset,
      lineOffset: block.loc.start.line - 1,
      jsx: lang === "tsx" || lang === "jsx",
      typescript: lang === "ts" || lang === "tsx",
    }]
  })
}

interface FileContext {
  block: Block
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  style: CodeStyle
  /** The new text of an import specifier that `replaceHttp()` changed. `null` when it removed it. */
  specifiers: Map<Node, string | null>
}

type Specifier = ImportDeclaration["specifiers"][number]

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(context.block.offset + start(node), context.block.offset + end(node), text)
}

function importedName(specifier: Specifier): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

function isNamedImport(statement: ImportDeclaration): boolean {
  return statement.specifiers.length > 0 && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")
}

function replaceSource(context: FileContext, source: StringLiteral) {
  overwrite(context, source, quoteString(channelsPath, context.style))
}

/**
 * Moves imports and re-exports of `vite-hub/agent/channels` to `vite-hub/channels`. A named import joins an earlier
 * named import of `vite-hub/channels` of the same kind, so a file ends with one import.
 */
function moveImports(context: FileContext) {
  const { block, output, program } = context
  const targets = new Map<string, ImportDeclaration>()
  const key = (statement: ImportDeclaration) => `${statement.importKind ?? "value"}`
  for (const statement of program.program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === channelsPath && isNamedImport(statement) && !targets.has(key(statement))) {
      targets.set(key(statement), statement)
    }
  }
  for (const statement of program.program.body) {
    if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source?.value === movedPath) {
      replaceSource(context, statement.source)
      continue
    }
    if (statement.type !== "ImportDeclaration" || statement.source.value !== movedPath) continue
    const target = isNamedImport(statement) ? targets.get(key(statement)) : undefined
    if (!target) {
      replaceSource(context, statement.source)
      if (isNamedImport(statement)) targets.set(key(statement), statement)
      continue
    }
    // `replaceHttp()` ran first, so take the names with its edits.
    const names = statement.specifiers.flatMap((specifier) => {
      const text = context.specifiers.get(specifier)
      return text === null ? [] : [text ?? block.code.slice(start(specifier), end(specifier))]
    }).join(", ")
    if (names) output.appendLeft(block.offset + end(target.specifiers.at(-1)!), `, ${names}`)
    const [from, to] = listItemRemoval(block.code, statement)
    output.remove(block.offset + from, block.offset + to)
  }
  walk(program, (node) => {
    if (node.type === "ImportExpression" && node.source.type === "StringLiteral" && node.source.value === movedPath) {
      replaceSource(context, node.source)
      return
    }
    if (node.type !== "CallExpression") return
    const [first] = node.arguments
    if (first?.type !== "StringLiteral" || first.value !== movedPath) return
    const callee = node.callee
    const name = callee.type === "Import" ? "import" : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : undefined
    if (name === "import" || (name && moduleCalls.has(name))) replaceSource(context, first)
  })
}

/** `http(options)` becomes `channelAdapter("http", options)`, the same Channel with the generic adapter. */
function replaceHttp(context: FileContext) {
  const { block, output, program, style } = context
  const imports = program.program.body.filter((statement): statement is ImportDeclaration =>
    statement.type === "ImportDeclaration" && httpModules.has(statement.source.value) && statement.importKind !== "type")
  const valueSpecifiers = imports.flatMap(statement => statement.specifiers.flatMap(specifier =>
    specifier.type === "ImportSpecifier" && specifier.importKind !== "type" ? [{ statement, specifier }] : []))
  const http = valueSpecifiers.filter(({ specifier }) => importedName(specifier) === "http")
  if (!http.length) return
  let adapterName = valueSpecifiers.find(({ specifier }) => importedName(specifier) === "channelAdapter")?.specifier.local.name
  const resolve = bindingResolver(program)
  const references = new Map<Identifier, Identifier[]>(http.map(({ specifier }) => [specifier.local, []]))
  const parents = new Map<Identifier, Node | undefined>()
  const names = new Set<string>()
  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier") return
    names.add(node.name)
    if (!isReference(node, ancestors.at(-1))) return
    const binding = resolve(node)
    const list = binding && references.get(binding)
    if (!list) return
    list.push(node)
    parents.set(node, ancestors.at(-1))
  })
  const kind = quoteString("http", style)
  for (const { statement, specifier } of http) {
    const calls = references.get(specifier.local)!
    const other = calls.find((node) => {
      const parent = parents.get(node)
      return parent?.type !== "CallExpression" || parent.callee !== node
    })
    if (other) {
      followUp(context, other, "`http()` was removed. Import `channelAdapter` from `vite-hub/channels`, and replace this reference with `(options) => channelAdapter(\"http\", options)`.")
      continue
    }
    let callee: string
    if (adapterName) {
      // The file already imports `channelAdapter`: drop `http` and call the existing name.
      const [from, to] = listItemRemoval(block.code, statement.specifiers.length === 1 ? statement : specifier)
      output.remove(block.offset + from, block.offset + to)
      context.specifiers.set(specifier, null)
      callee = adapterName
    }
    else if (specifier.local.name !== "http") {
      overwrite(context, specifier.imported, "channelAdapter")
      context.specifiers.set(specifier, `channelAdapter as ${specifier.local.name}`)
      callee = specifier.local.name
    }
    else if (names.has("channelAdapter")) {
      followUp(context, specifier, "`http()` was removed. Import `channelAdapter` from `vite-hub/channels`, and replace `http(options)` with `channelAdapter(\"http\", options)`. This file already has a `channelAdapter` name, so the codemod left it.")
      continue
    }
    else {
      overwrite(context, specifier, "channelAdapter")
      context.specifiers.set(specifier, "channelAdapter")
      callee = adapterName = "channelAdapter"
    }
    for (const node of calls) {
      const call = parents.get(node)
      if (call?.type !== "CallExpression") continue
      if (callee !== node.name) overwrite(context, node, callee)
      const open = block.code.indexOf("(", end(call.typeParameters ?? node))
      output.appendLeft(block.offset + open + 1, call.arguments.length ? `${kind}, ` : kind)
    }
  }
}

function rewriteBlock(context: FileContext): boolean {
  const before = context.output.toString()
  replaceHttp(context)
  moveImports(context)
  return context.output.toString() !== before
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needle.test(source)) continue
    const output = new MagicString(source)
    let changed = false
    for (const block of scriptBlocks(file, source)) {
      if (!needle.test(block.code)) continue
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Import Channel adapters from \`vite-hub/channels\`, and replace \`http(options)\` with \`channelAdapter("http", options)\` by hand.` })
        continue
      }
      const context: FileContext = { block, file, followUps, output, program, specifiers: new Map(), style: detectStyle(block.code, program) }
      changed = rewriteBlock(context) || changed
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `moved Channel imports to vite-hub/channels in ${edits.length} file(s)` : "found no vite-hub/agent/channels import or http() Channel",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const channels: Codemod = {
  name: "channels",
  description: "Import Channel adapters from `vite-hub/channels`, and replace `http()` with `channelAdapter(\"http\")`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} imports \`vite-hub/agent/channels\` or calls \`http()\`` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs the \`vite-hub/channels\` change` } : undefined
  },
  run: migrate,
}
