import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, isReference, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { CallExpression, File, Identifier, ImportDeclaration, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** Modules that exported `http()`. `http(options)` is now `channelAdapter("http", options)`. */
const httpModules = new Set(["vite-hub/agent/channels", "@vite-hub/agent/channels"])

/**
 * `vite-hub/agent/channels` is removed. Its adapters moved to `vite-hub/channels/adapters`, which re-exports
 * `@vite-hub/agent/channels`, and the names that need no Agent moved to `vite-hub/channels`. The owner path
 * `@vite-hub/agent/channels` stays.
 */
const movedPath = "vite-hub/agent/channels"
const adaptersPath = "vite-hub/channels/adapters"
const channelsPath = "vite-hub/channels"
const channelNames = new Set(["defineChannelTrigger", "ignored", "rejected", "retryLater"])

/** `webhook()` and `stripe()` left the root of `vite-hub/channels` and `@vite-hub/channels` for its adapters entry. */
const rootModules = new Set([channelsPath, "@vite-hub/channels"])
const rootAdapterNames = new Set(["webhook", "stripe", "StripeEvent", "StripeAdapterOptions"])

/** Calls whose first argument names a module, such as `vi.mock("vite-hub/agent/channels")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /vite-hub\/agent\/channels|\bhttp\b|vite-hub\/channels/

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
  hasOtherScript?: boolean
  templateNames?: Set<string>
  hasExternalTemplate?: boolean
}

function scriptBlocks(file: string, source: string): Block[] {
  if (!file.endsWith(".vue")) {
    return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(source, { filename: file })
  const { script, scriptSetup, template } = descriptor
  const templateNames = new Set(template?.content.match(/[$\p{ID_Continue}\u200c\u200d]+/gu))
  return [script, scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{
      code: block.content,
      offset: block.loc.start.offset,
      lineOffset: block.loc.start.line - 1,
      jsx: lang === "tsx" || lang === "jsx",
      typescript: lang === "ts" || lang === "tsx",
      hasOtherScript: !!(script && scriptSetup),
      templateNames,
      hasExternalTemplate: !!template?.src,
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
    if (block.hasOtherScript || block.hasExternalTemplate || block.templateNames?.has(specifier.local.name)) {
      followUp(context, specifier, `Check this Vue import and its references in other scripts or the template. ${manualHttp}`)
      continue
    }
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

function moveSource(context: FileContext, source: StringLiteral, to: string) {
  overwrite(context, source, quoteString(to, context.style))
}

/**
 * Moves `webhook`, `stripe`, and their types from the root of `vite-hub/channels` or `@vite-hub/channels` to its
 * adapters entry. Returns the import statements that it changed.
 */
function moveRootAdapters(context: FileContext): Set<ImportDeclaration> {
  const { block, output, program, style } = context
  const semicolon = style.semicolons ? ";" : ""
  const changed = new Set<ImportDeclaration>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !rootModules.has(statement.source.value)) continue
    const adaptersSource = `${statement.source.value}/adapters`
    const namespace = statement.specifiers.find(specifier => specifier.type === "ImportNamespaceSpecifier")
    if (namespace) {
      let used = false
      walk(program, (node) => {
        if (node.type !== "MemberExpression" || node.object.type !== "Identifier" || node.object.name !== namespace.local.name) return
        const name = node.computed ? (node.property.type === "StringLiteral" ? node.property.value : undefined) : node.property.type === "Identifier" ? node.property.name : undefined
        if (name === "webhook" || name === "stripe") used = true
      })
      if (used) followUp(context, namespace, `\`webhook()\` and \`stripe()\` moved to \`${adaptersSource}\`. Import them from there.`)
      continue
    }
    const moved = statement.specifiers.filter(specifier => rootAdapterNames.has(importedName(specifier) ?? ""))
    if (!moved.length) continue
    changed.add(statement)
    if (moved.length === statement.specifiers.length) {
      moveSource(context, statement.source, adaptersSource)
      continue
    }
    const names = moved.map(specifier => block.code.slice(start(specifier), end(specifier))).join(", ")
    for (const specifier of moved) {
      const [from, to] = listItemRemoval(block.code, specifier)
      output.remove(block.offset + from, block.offset + to)
    }
    const keyword = statement.importKind === "type" ? "import type" : "import"
    output.appendLeft(block.offset + end(statement), `\n${keyword} { ${names} } from ${quoteString(adaptersSource, style)}${semicolon}`)
  }
  return changed
}

/**
 * Moves imports of `vite-hub/agent/channels`. A named import of only `defineChannelTrigger`, `ignored`, `retryLater`,
 * or `rejected` moves to `vite-hub/channels`. A mixed import moves to `vite-hub/channels/adapters`, and those names
 * join an import of `vite-hub/channels`. Everything else moves to `vite-hub/channels/adapters`, which has every name.
 */
function moveImports(context: FileContext, changed: ReadonlySet<ImportDeclaration>) {
  const { block, output, program, style } = context
  const semicolon = style.semicolons ? ";" : ""
  const channelImports = new Map<string, ImportDeclaration>()
  for (const statement of program.program.body) {
    // A statement that `moveRootAdapters()` changed takes no more names: its edited text has other bounds.
    if (statement.type !== "ImportDeclaration" || statement.source.value !== channelsPath || changed.has(statement)) continue
    if (statement.specifiers.length && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")) {
      channelImports.set(statement.importKind ?? "value", statement)
    }
  }
  for (const statement of program.program.body) {
    if ((statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration") && statement.source?.value === movedPath) {
      moveSource(context, statement.source, adaptersPath)
      continue
    }
    if (statement.type !== "ImportDeclaration" || statement.source.value !== movedPath) continue
    const named = statement.specifiers.length > 0 && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")
    const moved = named ? statement.specifiers.filter(specifier => channelNames.has(importedName(specifier) ?? "")) : []
    if (moved.length && moved.length === statement.specifiers.length) {
      moveSource(context, statement.source, channelsPath)
      continue
    }
    moveSource(context, statement.source, adaptersPath)
    if (!moved.length) continue
    const names = moved.map(specifier => block.code.slice(start(specifier), end(specifier))).join(", ")
    for (const specifier of moved) {
      const [from, to] = listItemRemoval(block.code, specifier)
      output.remove(block.offset + from, block.offset + to)
    }
    const kind = statement.importKind ?? "value"
    const target = channelImports.get(kind)
    if (target) {
      output.appendLeft(block.offset + end(target.specifiers.at(-1)!), `, ${names}`)
      continue
    }
    const keyword = kind === "type" ? "import type" : "import"
    output.appendLeft(block.offset + end(statement), `\n${keyword} { ${names} } from ${quoteString(channelsPath, style)}${semicolon}`)
  }
  walk(program, (node) => {
    const first = node.type === "ImportExpression" ? node.source : node.type === "CallExpression" ? node.arguments[0] : undefined
    if (first?.type !== "StringLiteral" || first.value !== movedPath) return
    const callee = node.type === "CallExpression" ? node.callee : undefined
    const mock = callee?.type === "MemberExpression" && callee.property.type === "Identifier" && moduleCalls.has(callee.property.name)
    const load = node.type === "ImportExpression" || callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require")
    if (!mock && !load) return
    moveSource(context, first, adaptersPath)
    if (mock) followUp(context, node, "This mock now replaces `vite-hub/channels/adapters`. `defineChannelTrigger`, `ignored`, `retryLater`, and `rejected` also come from `vite-hub/channels`: mock that path too when the code under test imports them from it.")
  })
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
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). ${manualHttp}` })
        continue
      }
      const before = output.toString()
      const context: FileContext = { block, file, followUps, output, program, style: detectStyle(block.code, program) }
      replaceHttp(context)
      moveImports(context, moveRootAdapters(context))
      changed = output.toString() !== before || changed
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `moved Channel imports and replaced http() in ${edits.length} file(s)` : "no Channel import or http() call changed",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const channels: Codemod = {
  name: "channels",
  description: "Move `vite-hub/agent/channels` imports to `vite-hub/channels/adapters` and `vite-hub/channels`, and replace `http()` with `channelAdapter(\"http\")`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} imports \`vite-hub/agent/channels\` or calls the Agent \`http()\` adapter` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs a manual Agent Channel migration` } : undefined
  },
  run: migrate,
}
