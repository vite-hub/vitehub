import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { findNuxtConfigName } from "../shared/nuxt-config.ts"

import type { CallExpression, Expression, File, Identifier } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const kvModules = new Set(["vite-hub/kv", "@vite-hub/kv"])

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

function scriptBlocks(file: string, source: string): Block[] {
  if (!file.endsWith(".vue")) return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  const { descriptor } = parseSfc(source, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{ code: block.content, offset: block.loc.start.offset, lineOffset: block.loc.start.line - 1, jsx: lang === "tsx" || lang === "jsx", typescript: lang === "ts" || lang === "tsx" }]
  })
}

/** The local declarations of `kv` imported from the KV modules. */
function kvBindings(program: File): Set<Identifier> {
  const names = new Set<Identifier>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !kvModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && keyName(specifier.imported) === "kv") names.add(specifier.local)
    }
  }
  return names
}

/** True for `kv`, `kv.store(name)`, or a variable that holds `kv.store(name)`. */
function isKV(node: Node, names: ReadonlySet<Identifier>, resolve: (node: Identifier) => Identifier | undefined, handles: ReadonlySet<Identifier>, autoImport: boolean): boolean {
  if (node.type === "Identifier") {
    const binding = resolve(node)
    return binding ? names.has(binding) || handles.has(binding) : autoImport && node.name === "kv"
  }
  return node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
    && node.callee.property.type === "Identifier" && node.callee.property.name === "store" && isKV(node.callee.object, names, resolve, handles, autoImport)
}

/** The text of a prefix that keeps the old meaning, the keys below `base`: a string literal gets a `:` at its end. */
function belowPrefix(block: Block, argument: Expression): string | undefined {
  const value = argument.type === "StringLiteral" ? argument.value
    : argument.type === "TemplateLiteral" && argument.expressions.length === 0 ? argument.quasis[0]?.value.cooked : undefined
  if (value == null) return
  const path = value.split("?", 1)[0] ?? ""
  const needsSeparator = path !== "" && !/[:/\\]$/.test(path)
  if (path !== value) return JSON.stringify(needsSeparator ? `${path}:` : path)
  const literal = block.code.slice(start(argument), end(argument))
  return needsSeparator ? `${literal.slice(0, -1)}:${literal.slice(-1)}` : literal
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const nuxt = Boolean(findNuxtConfigName(cwd))
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    const autoImport = nuxt && file.startsWith("server/") && !file.endsWith(".vue")
    if ((!autoImport && !code.includes("vite-hub/kv")) || !/\.(?:keys|clear)\s*\(/.test(code)) continue
    const output = new MagicString(code)
    let changed = false
    for (const block of scriptBlocks(file, code)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch {
        continue
      }
      const names = kvBindings(program)
      if (!names.size && !autoImport) continue
      const resolve = bindingResolver(program)
      const handles = new Set<Identifier>()
      walk(program, (node) => {
        if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && isKV(node.init, names, resolve, handles, autoImport)) handles.add(node.id)
      })
      const overwrite = (node: Node, text: string) => {
        output.overwrite(block.offset + start(node), block.offset + end(node), text)
        changed = true
      }
      /** Replaces the arguments between the parentheses of `call`. */
      const replaceArguments = (call: CallExpression, text: string) => {
        const open = block.code.indexOf("(", end(call.callee)) + 1
        const close = end(call) - 1
        if (open < close) output.overwrite(block.offset + open, block.offset + close, text)
        else output.appendLeft(block.offset + open, text)
        changed = true
      }
      const report = (node: Node, message: string) => followUps.push({ file, line: block.lineOffset + line(node), message })
      walk(program, (node, ancestors) => {
        if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.computed || node.callee.property.type !== "Identifier") return
        const callee = node.callee
        const property = node.callee.property
        const method = property.name
        if ((method !== "keys" && method !== "clear") || !isKV(callee.object, names, resolve, handles, autoImport)) return
        const call: CallExpression = node
        const [argument, ...rest] = call.arguments
        if (rest.length || argument?.type === "SpreadElement" || argument?.type === "ArgumentPlaceholder") {
          report(call, `\`kv.${method}()\` takes one options object now. Pass \`{ prefix }\` by hand.`)
          return
        }
        // `clear()` without a base, or with an options object, is already the new form.
        if (method === "clear" && (!argument || argument.type === "ObjectExpression")) return
        const prefix = argument ? belowPrefix(block, argument) : undefined
        if (argument && prefix === undefined) {
          report(call, `\`kv.${method}(base)\` matched the keys below \`base\`, and \`{ prefix }\` matches text. Pass \`{ prefix }\` with a \`:\` at its end by hand.`)
          return
        }
        const options = prefix === undefined ? "" : `{ prefix: ${prefix} }`
        if (method === "clear") {
          replaceArguments(call, options)
          return
        }
        // `const [error, keys] = await kv.keys(base)` reads the keys of the page that `list()` returns.
        const awaited = ancestors.at(-1)
        const declarator = ancestors.at(-2)
        if (awaited?.type === "AwaitExpression" && declarator?.type === "VariableDeclarator" && declarator.init === awaited
          && declarator.id.type === "ArrayPattern" && declarator.id.elements.length === 2 && declarator.id.elements[1]?.type === "Identifier") {
          const target = declarator.id.elements[1]
          overwrite(target, `{ ${target.name === "keys" ? "keys" : `keys: ${target.name}`} } = { keys: [] }`)
          overwrite(property, "list")
          replaceArguments(call, options)
          return
        }
        report(call, "`kv.keys()` was removed. Use `kv.list({ prefix })`, which returns `[error, { keys }]` with every key when you set no `limit`.")
      })
    }
    if (changed) edits.push({ path: file, before: code, after: output.toString() })
  }
  return {
    summary: edits.length ? `moved kv.keys() and kv.clear(base) to list({ prefix }) and clear({ prefix }) in ${edits.length} file(s)` : "found no kv.keys() or kv.clear(base) call",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const kvListPrefix: Codemod = {
  name: "kv-list-prefix",
  description: "Move `kv.keys(base)` to `kv.list({ prefix })` and `kv.clear(base)` to `kv.clear({ prefix })`, with the prefix of the keys below `base`",
  usage: "[dir]",
  detectAfterEdits: true,
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} calls kv.keys() or kv.clear(base)` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} calls kv.keys() or kv.clear(base)` } : undefined
  },
  run: migrate,
}
