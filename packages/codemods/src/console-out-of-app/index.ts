import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, listItemRemoval, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, Identifier } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const authModule = "vite-hub/console/auth"
const pageContextType = "ConsolePageAuthorizeContext"
const authorizeFile = /(?:^|\/)server\/console-authorize\.[cm]?[jt]s$/
const sourcePatterns = ["**/*.{ts,mts,cts,js,mjs,cjs}"]
const envPatterns = [".env", ".env.*", ".dev.vars", "wrangler.toml", "wrangler.json", "wrangler.jsonc", "**/.env", "**/.env.*", "**/.dev.vars", "**/wrangler.toml", "**/wrangler.json", "**/wrangler.jsonc"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

const pageBranch = "`console.authorize` no longer gets `via: \"page\"`: the Comments pill loads the Console segment from the ViteHub Console, which checks the person and the team. Remove the code that handles `\"page\"`."
const pageType = "`ConsolePageAuthorizeContext` was removed with `via: \"page\"`. Remove the type and the code that handles `\"page\"`."
const mcpKey = "`VITEHUB_CONSOLE_MCP_KEY` is not read anymore: the MCP client section of the ViteHub Console connects to MCP servers from the Console server. Remove this line, and remove the secret from each deployment."

type FunctionNode = Extract<Node, { type: "ArrowFunctionExpression" | "FunctionDeclaration" | "FunctionExpression" }>

function isFunction(node: Node | null | undefined): node is FunctionNode {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionDeclaration" || node?.type === "FunctionExpression"
}

function isVia(node: Node): boolean {
  const value = unwrapExpression(node)
  if (value.type === "Identifier") return value.name === "via"
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") return false
  return keyName(value.property, value.computed) === "via"
}

function isPage(node: Node): boolean {
  const value = unwrapExpression(node)
  return value.type === "StringLiteral" && value.value === "page"
}

function authorizeFunctions(file: string, program: File): FunctionNode[] {
  const resolve = bindingResolver(program)
  const defines = new Set<Identifier>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== authModule) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && keyName(specifier.imported) === "defineConsoleAuthorize") defines.add(specifier.local)
    }
  }
  const declarations = new Map<Identifier, FunctionNode>()
  walk(program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) declarations.set(node.id, node)
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const init = unwrapExpression(node.init)
      if (isFunction(init)) declarations.set(node.id, init)
    }
  })
  const functionOf = (node: Node | null | undefined): FunctionNode | undefined => {
    if (!node) return undefined
    const value = unwrapExpression(node)
    if (isFunction(value)) return value
    if (value.type !== "Identifier") return undefined
    const binding = resolve(value)
    return binding ? declarations.get(binding) : undefined
  }
  const found = new Set<FunctionNode>()
  walk(program, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const binding = resolve(node.callee)
      const argument = node.arguments[0]
      const fn = binding && defines.has(binding) && argument?.type !== "SpreadElement" ? functionOf(argument) : undefined
      if (fn) found.add(fn)
    }
    if (node.type === "ExportDefaultDeclaration" && authorizeFile.test(file)) {
      const fn = functionOf(node.declaration)
      if (fn) found.add(fn)
    }
  })
  return [...found]
}

/** Removes the `via === "page"` branch of `console.authorize` and the `ConsolePageAuthorizeContext` import from one file. */
export function migrateConsoleAuthorize(file: string, code: string): { code: string, changed: boolean, followUps: FollowUp[] } {
  const followUps: FollowUp[] = []
  const unchanged = { code, changed: false, followUps }
  if (!code.includes(authModule) && !authorizeFile.test(file)) return unchanged
  let program: File
  try {
    program = parseProgram(code, { jsx: false, typescript: !/\.(?:c|m)?js$/.test(file) })
  }
  catch {
    return unchanged
  }
  const output = new MagicString(code)
  let changed = false
  const removedRanges: Array<[number, number]> = []
  const removeRange = (range: [number, number]) => {
    output.remove(range[0], range[1])
    removedRanges.push(range)
    changed = true
  }
  const inRemoved = (node: Node) => removedRanges.some(([from, to]) => start(node) >= from && end(node) <= to)
  const follow = (node: Node, message: string) => followUps.push({ file, line: line(node), message })

  for (const fn of authorizeFunctions(file, program)) {
    walk(fn, (node, ancestors) => {
      if (inRemoved(node)) return
      if (node.type === "SwitchCase" && node.test && isPage(node.test)) {
        const parent = ancestors.at(-1)
        if (parent?.type === "SwitchStatement" && isVia(parent.discriminant)) follow(node, pageBranch)
        return
      }
      if (node.type !== "BinaryExpression" || !["===", "==", "!==", "!="].includes(node.operator)) return
      if (node.left.type === "PrivateName") return
      if (!((isVia(node.left) && isPage(node.right)) || (isPage(node.left) && isVia(node.right)))) return
      const parent = ancestors.at(-1)
      const block = ancestors.at(-2)
      const removable = (node.operator === "===" || node.operator === "==")
        && parent?.type === "IfStatement" && parent.test === node && !parent.alternate
        && (block?.type === "BlockStatement" || block?.type === "Program")
      if (removable) removeRange(listItemRemoval(code, parent))
      else follow(node, pageBranch)
    })
  }

  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== authModule) continue
    const pageSpecifiers = statement.specifiers.filter(specifier => specifier.type === "ImportSpecifier" && keyName(specifier.imported) === pageContextType)
    for (const specifier of pageSpecifiers) {
      const local = specifier.local.name
      let used = false
      walk(program, (node, ancestors) => {
        if (used || node.type !== "Identifier" || node.name !== local || node === specifier.local || inRemoved(node)) return
        if (ancestors.at(-1) === specifier) return
        used = true
      })
      if (used) {
        follow(specifier, pageType)
        continue
      }
      if (statement.specifiers.length === pageSpecifiers.length) {
        removeRange(listItemRemoval(code, statement))
        break
      }
      removeRange(listItemRemoval(code, specifier))
    }
  }
  return changed ? { code: output.toString(), changed, followUps } : unchanged
}

async function mcpKeyFollowUps(cwd: string): Promise<FollowUp[]> {
  const followUps: FollowUp[] = []
  for (const file of (await glob(envPatterns, { cwd, ignore: ignoredPatterns, dot: true })).sort()) {
    const text = await readFile(join(cwd, file), "utf8").catch(() => "")
    text.split("\n").forEach((value, index) => {
      if (/\bVITEHUB_CONSOLE_MCP_KEY\b/.test(value)) followUps.push({ file, line: index + 1, message: mcpKey })
    })
  }
  return followUps
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()) {
    const before = await readFile(join(cwd, file), "utf8")
    const result = migrateConsoleAuthorize(file, before)
    followUps.push(...result.followUps)
    if (result.changed) edits.push({ path: file, before, after: result.code })
  }
  followUps.push(...await mcpKeyFollowUps(cwd))
  return {
    summary: edits.length ? `removed the Console page check from ${edits.length} file(s)` : "found no Console page check to remove",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const consoleOutOfApp: Codemod = {
  name: "console-out-of-app",
  description: "Remove the `via: \"page\"` branch of `console.authorize` and `ConsolePageAuthorizeContext`, and report `VITEHUB_CONSOLE_MCP_KEY`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} checks the Console link of the page tools pill` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} uses a Console option that left the app` } : undefined
  },
  run: migrate,
}
