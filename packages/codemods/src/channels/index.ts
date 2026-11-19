import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, isReference, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { CallExpression, File, Identifier, ImportDeclaration } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** Modules that exported `http()`. `http(options)` is now `channelAdapter("http", options)`. */
const httpModules = new Set(["vite-hub/agent/channels", "@vite-hub/agent/channels"])

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

const manualHttp = '`http()` was removed. Use `channelAdapter("http", options)` from the same module to keep the Channel kind.'

function reportIndirectUses(context: FileContext): Set<string> {
  const mocked = new Set<string>()
  walk(context.program, (node, ancestors) => {
    if (node.type === "ExportAllDeclaration" && httpModules.has(node.source.value)) {
      followUp(context, node, `Check consumers of this wildcard re-export. ${manualHttp}`)
      return
    }
    if (node.type === "ExportNamedDeclaration" && node.source && httpModules.has(node.source.value)) {
      if (node.specifiers.some(specifier => specifier.type === "ExportNamespaceSpecifier" || (specifier.type === "ExportSpecifier" && specifier.local.name === "http"))) {
        followUp(context, node, manualHttp)
      }
      return
    }
    if (node.type === "ImportDeclaration" && httpModules.has(node.source.value) && node.specifiers.some(specifier => specifier.type === "ImportNamespaceSpecifier")) {
      followUp(context, node, `Check this namespace import for references to the removed http export. ${manualHttp}`)
      return
    }
    if (node.type !== "CallExpression" && node.type !== "ImportExpression") return
    const callee = node.type === "CallExpression" ? node.callee : undefined
    const first = node.type === "CallExpression" ? node.arguments[0] : node.source
    const source = first?.type === "ImportExpression" ? first.source
      : first?.type === "CallExpression" && first.callee.type === "Import" ? first.arguments[0] : first
    if (source?.type !== "StringLiteral" || !httpModules.has(source.value)) return
    if (callee?.type === "MemberExpression" && callee.property.type === "Identifier" && moduleCalls.has(callee.property.name)) {
      mocked.add(source.value)
      followUp(context, node, `Check this mock for the removed http export. Update the mock and its callers together. ${manualHttp}`)
      return
    }
    if (node.type === "ImportExpression" || callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require")) {
      const parent = ancestors.at(-1)
      if (parent?.type === "CallExpression" && parent.callee.type === "MemberExpression"
        && parent.callee.property.type === "Identifier" && moduleCalls.has(parent.callee.property.name)) return
      followUp(context, node, `Check this module load for references to the removed http export. ${manualHttp}`)
    }
  })
  return mocked
}

function isSimpleCall(call: CallExpression): boolean {
  if (call.typeParameters || call.typeArguments) return false
  const [options] = call.arguments
  if (!options) return true
  return call.arguments.length === 1 && options.type === "ObjectExpression" && options.properties.every(property =>
    property.type === "ObjectProperty" && !property.computed
    && (property.key.type === "Identifier" || property.key.type === "StringLiteral")
    && (property.key.type === "Identifier" ? property.key.name : property.key.value) === "route"
    && property.value.type === "BooleanLiteral")
}

function replaceHttp(context: FileContext) {
  const { block, output, program, style } = context
  const mocked = reportIndirectUses(context)
  const imports = program.program.body.flatMap(statement =>
    statement.type === "ImportDeclaration" && httpModules.has(statement.source.value)
      ? statement.specifiers.flatMap(specifier => importedName(specifier) === "http" ? [{ statement, specifier }] : []) : [])
  if (!imports.length) return
  const resolve = bindingResolver(program)
  const references = new Map(imports.map(({ specifier }) => [specifier.local, new Map<Identifier, Node>()]))
  const names = new Set<string>()
  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier") return
    names.add(node.name)
    const parent = ancestors.at(-1)
    if (!parent || !isReference(node, parent)) return
    const binding = resolve(node)
    if (binding) references.get(binding)?.set(node, parent)
  })
  const kind = quoteString("http", style)
  for (const { statement, specifier } of imports) {
    if (specifier.type !== "ImportSpecifier" || mocked.has(statement.source.value)) continue
    if (statement.importKind === "type" || specifier.importKind === "type") {
      followUp(context, specifier, manualHttp)
      continue
    }
    const uses = references.get(specifier.local) ?? new Map<Identifier, Node>()
    const unsafe = [...uses].find(([node, parent]) => parent.type !== "CallExpression" || parent.callee !== node || !isSimpleCall(parent))
    if (unsafe) {
      followUp(context, unsafe[0], `${manualHttp} Adapt references and typed calls by hand. For typed routes, type the callbacks explicitly, or use webChat() if changing the kind is acceptable.`)
      continue
    }
    let callee = specifier.local.name
    if (callee === "http") {
      callee = "channelAdapter"
      let suffix = 2
      while (names.has(callee)) callee = `channelAdapter${suffix++}`
      names.add(callee)
    }
    overwrite(context, specifier, callee === "channelAdapter" ? callee : `channelAdapter as ${callee}`)
    for (const [node, call] of uses) {
      if (call.type !== "CallExpression") continue
      if (callee !== node.name) overwrite(context, node, callee)
      const first = call.arguments[0]
      const parenStart: unknown = first?.extra?.parenStart
      const insertion = first ? typeof parenStart === "number" ? parenStart : start(first) : end(call) - 1
      output.appendLeft(block.offset + insertion, first ? `${kind}, ` : kind)
    }
  }
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
      const before = output.toString()
      replaceHttp({ block, file, followUps, output, program, style: detectStyle(block.code, program) })
      changed = output.toString() !== before || changed
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `replaced http() in ${edits.length} file(s)` : "no http() calls changed",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const channels: Codemod = {
  name: "channels",
  description: "Replace the Agent `http()` adapter with `channelAdapter(\"http\")`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} calls the Agent \`http()\` adapter` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs a manual Agent Channel migration` } : undefined
  },
  run: migrate,
}
