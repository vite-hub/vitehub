import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, isReference, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { File, Identifier, ImportDeclaration, ImportNamespaceSpecifier, ImportSpecifier } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** The modules that exported `auth` and `getAuth`. */
const serverModules = new Set(["vite-hub/auth/server", "@vite-hub/auth/server", "#vitehub/auth/server"])
/** The modules that exported `isGitHubOrgMember`. */
const rootModules = new Set(["vite-hub/auth", "@vite-hub/auth"])
/** The modules that exported `useSession`. */
const vueModules = new Set(["vite-hub/auth/vue", "@vite-hub/auth/vue"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /\bgetAuth\b|\bauth\b|\bisGitHubOrgMember\b|\buseSession\b/
/** Nitro auto-imports the Auth server helpers in these files. */
const serverFile = /(?:^|\/)server\//

const useSessionMessage = "`useSession()` was removed. Use `useUserSession()`: `data.value`, `pending.value`, `error.value`, and `refresh()` replace `.value.data`, `.value.isPending`, `.value.error`, and `.value.refetch()`. Better Auth's own ref is `useUserSession().client.useSession()`."

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

interface FileContext {
  block: Block
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  resolve: ReturnType<typeof bindingResolver>
  names: Set<string>
  replacements: Map<string, string>
  removed: Set<ImportSpecifier>
}

function scriptBlocks(file: string, source: string): Block[] {
  if (!file.endsWith(".vue")) {
    return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(source, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{ code: block.content, offset: block.loc.start.offset, lineOffset: block.loc.start.line - 1, jsx: lang === "tsx" || lang === "jsx", typescript: lang === "ts" || lang === "tsx" }]
  })
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(context.block.offset + start(node), context.block.offset + end(node), text)
}

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

/** The named imports of `name` from `modules`, and the namespace imports of `modules`. */
function importsOf(program: File, modules: ReadonlySet<string>, name: string): { named: ImportSpecifier[], namespaces: ImportNamespaceSpecifier[] } {
  const named: ImportSpecifier[] = []
  const namespaces: ImportNamespaceSpecifier[] = []
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !modules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.push(specifier)
      else if (specifier.type === "ImportSpecifier" && importedName(specifier) === name) named.push(specifier)
    }
  }
  return { named, namespaces }
}

/** Every reference to the binding `local`, or to the free name `free` when `local` is undefined. */
function references(context: FileContext, local: Identifier | undefined, free?: string) {
  const found: Array<{ node: Identifier, parent: Node | undefined, grandparent: Node | undefined }> = []
  walk(context.program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node === local || !isReference(node, parent)) return
    if (parent?.type === "TSQualifiedName" && parent.right === node) return
    const binding = context.resolve(node)
    if (local ? binding === local : binding === undefined && node.name === free) found.push({ node, parent, grandparent: ancestors.at(-2) })
  })
  return found
}

function isValueImport(program: File, specifier: ImportSpecifier): boolean {
  return specifier.importKind !== "type" && specifier.importKind !== "typeof"
    && program.program.body.some(statement => statement.type === "ImportDeclaration" && statement.importKind !== "type"
      && statement.importKind !== "typeof" && statement.specifiers.includes(specifier))
}

function replacementBinding(context: FileContext, specifier: ImportSpecifier, modules: ReadonlySet<string>, name: string, sites: Identifier[]): string {
  const existing = importsOf(context.program, modules, name).named.find(candidate =>
    isValueImport(context.program, candidate)
    && sites.every(site => context.resolve(site, candidate.local.name) === candidate.local))
  const generated = context.replacements.get(name)
  const replacement = existing?.local.name ?? generated
  if (replacement) {
    context.removed.add(specifier)
    return replacement
  }
  let local = name
  const alias = `viteHub${name[0]?.toUpperCase()}${name.slice(1)}`
  let suffix = 2
  if (context.names.has(local)) local = alias
  while (context.names.has(local)) local = `${alias}${suffix++}`
  context.names.add(local)
  context.replacements.set(name, local)
  overwrite(context, specifier, local === name ? name : `${name} as ${local}`)
  return local
}

function removeImports(context: FileContext) {
  const { code, offset } = context.block
  for (const statement of context.program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    const { specifiers } = statement
    const removed = specifiers.filter(specifier => specifier.type === "ImportSpecifier" && context.removed.has(specifier))
    if (!removed.length) continue
    if (removed.length === specifiers.length) {
      const after = /^[ \t]*\r?\n/.exec(code.slice(end(statement)))?.[0] ?? ""
      context.output.remove(offset + start(statement), offset + end(statement) + after.length)
      continue
    }
    let previous: ImportDeclaration["specifiers"][number] | undefined
    let firstRemoved: ImportSpecifier | undefined
    let lastRemoved: ImportSpecifier | undefined
    for (const specifier of specifiers) {
      if (specifier.type === "ImportSpecifier" && context.removed.has(specifier)) {
        firstRemoved ??= specifier
        lastRemoved = specifier
      }
      else {
        if (firstRemoved) context.output.remove(offset + start(firstRemoved), offset + start(specifier))
        firstRemoved = lastRemoved = undefined
        previous = specifier
      }
    }
    if (firstRemoved && lastRemoved && previous) {
      if (previous.type === "ImportDefaultSpecifier") {
        const comma = /^\s*,/.exec(code.slice(end(lastRemoved)))?.[0] ?? ""
        context.output.remove(offset + start(firstRemoved), offset + end(lastRemoved) + comma.length)
      }
      else context.output.remove(offset + end(previous), offset + end(lastRemoved))
    }
  }
}

/** `getAuth()` becomes `useAuth()`, and every use of the `auth` proxy becomes `useAuth()`. */
function rewriteServer(context: FileContext) {
  const { program } = context
  for (const name of ["getAuth", "auth"] as const) {
    const { named, namespaces } = importsOf(program, serverModules, name)
    const message = `Review this use of \`${name}\`. Import \`useAuth\` from \`vite-hub/auth/server\`, and pass the event in a route.`
    for (const namespace of namespaces) {
      walk(program, (node) => {
        if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === name
          && node.object.type === "Identifier" && context.resolve(node.object) === namespace.local) {
          overwrite(context, node.property, name === "auth" ? "useAuth()" : "useAuth")
        }
      })
    }
    for (const specifier of named) {
      if (!isValueImport(program, specifier)) {
        followUp(context, specifier, message)
        continue
      }
      const sites = references(context, specifier.local)
      const manual = sites.filter(({ parent, node }) => parent?.type === "ExportSpecifier" || parent?.type === "TSQualifiedName"
        || parent?.type === "AssignmentExpression" && parent.left === node || parent?.type === "UpdateExpression")
      if (manual.length) {
        for (const { node } of manual) followUp(context, node, message)
        continue
      }
      const useAuth = replacementBinding(context, specifier, serverModules, "useAuth", sites.map(({ node }) => node))
      for (const { node, parent } of sites) {
        const replacement = name === "auth" ? `${useAuth}()` : useAuth
        if (parent?.type === "TSTypeQuery" && name === "auth") overwrite(context, parent, `ReturnType<typeof ${useAuth}>`)
        else if (parent?.type === "ObjectProperty" && parent.shorthand && parent.value === node) overwrite(context, node, `${node.name}: ${replacement}`)
        else overwrite(context, node, replacement)
      }
    }
    if (serverFile.test(context.file)) {
      for (const { node } of references(context, undefined, name)) followUp(context, node, message)
    }
  }
}

function nonemptyOrganization(node: Node | undefined): boolean {
  if (node?.type === "StringLiteral") return node.value.length > 0
  if (node?.type === "SequenceExpression") return nonemptyOrganization(node.expressions.at(-1))
  return false
}

/** `await isGitHubOrgMember(...)` becomes `!(await checkGitHubOrgMember(...))[0]`. */
function rewriteGitHub(context: FileContext) {
  const { program, block } = context
  const { named } = importsOf(program, rootModules, "isGitHubOrgMember")
  for (const specifier of named) {
    const calls: Array<{ node: Identifier, awaited: Node }> = []
    const sites = references(context, specifier.local)
    for (const { node, parent, grandparent } of sites) {
      if (parent?.type === "CallExpression" && parent.callee === node && grandparent?.type === "AwaitExpression"
        && parent.arguments[0]?.type !== "SpreadElement" && nonemptyOrganization(parent.arguments[1])) {
        calls.push({ node, awaited: grandparent })
        continue
      }
      followUp(context, node, "`isGitHubOrgMember()` was removed. Call `checkGitHubOrgMember()`, which returns `[error]`. Keep returning `false` for an empty organization if your app allows one. Throw on `AUTH_GITHUB_UNAVAILABLE` in `access.policy.allow`, so a GitHub outage does not end every session.")
    }
    if (calls.length !== sites.length) continue
    const check = replacementBinding(context, specifier, rootModules, "checkGitHubOrgMember", sites.map(({ node }) => node))
    for (const { node, awaited } of calls) {
      overwrite(context, node, check)
      context.output.appendRight(block.offset + start(awaited), "(!(")
      context.output.prependLeft(block.offset + end(awaited), ")[0])")
    }
  }
}

/** `useSession()` has no mechanical rewrite: `useUserSession()` names its refs differently. */
function reportSession(context: FileContext) {
  const { named } = importsOf(context.program, vueModules, "useSession")
  for (const specifier of named) followUp(context, specifier, useSessionMessage)
  // Nuxt auto-imports `useSession()` from ViteHub in app code. On the server, the free name is H3's.
  if (named.length || serverFile.test(context.file)) return
  const [free] = references(context, undefined, "useSession").filter(({ node, parent }) => parent?.type === "CallExpression" && parent.callee === node)
  if (free) followUp(context, free.node, useSessionMessage)
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needle.test(source)) continue
    const output = new MagicString(source)
    for (const block of scriptBlocks(file, source)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Replace \`auth\` and \`getAuth()\` with \`useAuth(event)\`, and \`isGitHubOrgMember()\` with \`checkGitHubOrgMember()\`, by hand.` })
        continue
      }
      const names = new Set<string>()
      walk(program, (node) => {
        if (node.type === "Identifier" || node.type === "JSXIdentifier") names.add(node.name)
      })
      const context: FileContext = { block, file, followUps, output, program, resolve: bindingResolver(program), names, replacements: new Map(), removed: new Set() }
      rewriteServer(context)
      rewriteGitHub(context)
      removeImports(context)
      reportSession(context)
    }
    if (output.hasChanged()) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `moved ${edits.length} file(s) to useAuth() and checkGitHubOrgMember()` : "found no removed Auth accessor",
    edits,
    followUps,
    notes: edits.length ? ["`useAuth()` without an event reads the app's Auth Definition, as `auth` and `getAuth()` did. In a route, pass the event: `useAuth(event)`."] : [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const authAccessors: Codemod = {
  name: "auth-accessors",
  description: "Replace Auth's `auth` and `getAuth()` with `useAuth()`, `isGitHubOrgMember()` with `checkGitHubOrgMember()`, and list `useSession()` calls",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} uses a removed Auth accessor` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} uses a removed Auth accessor` } : undefined
  },
  run: migrate,
}
