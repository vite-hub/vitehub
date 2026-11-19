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
const serverModules = new Set(["vite-hub/auth/server", "@vite-hub/auth/server"])
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
  resolve: (node: Identifier) => Identifier | undefined
  /** Import declarations that got a `useAuth` or `checkGitHubOrgMember` specifier. */
  added: Map<ImportDeclaration, Set<string>>
  changed: number
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
  context.changed++
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

/** The local name of an import of `name` from `modules`, if the file has one. */
function localImport(program: File, modules: ReadonlySet<string>, name: string): string | undefined {
  return importsOf(program, modules, name).named[0]?.local.name
}

/** Every reference to the binding `local`, or to the free name `free` when `local` is undefined. */
function references(context: FileContext, local: Identifier | undefined, free?: string): Array<{ node: Identifier, parent: Node | undefined, grandparent: Node | undefined }> {
  const found: Array<{ node: Identifier, parent: Node | undefined, grandparent: Node | undefined }> = []
  walk(context.program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node === local || !isReference(node, parent)) return
    const binding = context.resolve(node)
    if (local ? binding === local : binding === undefined && node.name === free) found.push({ node, parent, grandparent: ancestors.at(-2) })
  })
  return found
}

/**
 * Replaces an import specifier with `to`, or removes it when the declaration already imports `to`. A removed
 * specifier takes its comma with it.
 */
function replaceSpecifier(context: FileContext, declaration: ImportDeclaration, specifier: ImportSpecifier, to: string) {
  const added = context.added.get(declaration) ?? new Set<string>()
  context.added.set(declaration, added)
  const exists = added.has(to) || declaration.specifiers.some(other => other !== specifier && importedName(other) === to)
  added.add(to)
  if (!exists) {
    overwrite(context, specifier, to)
    return
  }
  const index = declaration.specifiers.indexOf(specifier)
  const next = declaration.specifiers[index + 1]
  const previous = declaration.specifiers[index - 1]
  const { offset } = context.block
  if (next) context.output.remove(offset + start(specifier), offset + start(next))
  else if (previous) context.output.remove(offset + end(previous), offset + end(specifier))
  context.changed++
}

function declarationOf(program: File, specifier: ImportSpecifier): ImportDeclaration {
  // SAFETY: the specifier came from one of the program's import declarations.
  return program.program.body.find(statement => statement.type === "ImportDeclaration" && statement.specifiers.includes(specifier)) as ImportDeclaration
}

/** `getAuth()` becomes `useAuth()`, and every use of the `auth` proxy becomes `useAuth()`. */
function rewriteServer(context: FileContext) {
  const { program } = context
  const useAuth = localImport(program, serverModules, "useAuth") ?? "useAuth"
  for (const name of ["getAuth", "auth"] as const) {
    const { named, namespaces } = importsOf(program, serverModules, name)
    for (const namespace of namespaces) {
      walk(program, (node) => {
        if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === name
          && node.object.type === "Identifier" && context.resolve(node.object) === namespace.local) {
          overwrite(context, node.property, name === "auth" ? "useAuth()" : "useAuth")
        }
      })
    }
    for (const specifier of named) {
      if (rewriteReferences(context, name, specifier.local, useAuth)) replaceSpecifier(context, declarationOf(program, specifier), specifier, "useAuth")
    }
  }
  if (!serverFile.test(context.file)) return
  // Nitro auto-imports the helpers in `server/`, so a free name is the helper.
  rewriteReferences(context, "getAuth", undefined, "useAuth")
  for (const { node, parent } of references(context, undefined, "auth")) {
    if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.object === node) overwrite(context, node, "useAuth()")
  }
}

/** Returns false when a reference cannot change, so the import stays. */
function rewriteReferences(context: FileContext, name: "auth" | "getAuth", local: Identifier | undefined, useAuth: string): boolean {
  let kept = false
  for (const { node, parent } of references(context, local, name)) {
    if (parent?.type === "ExportSpecifier") {
      followUp(context, node, `\`${name}\` was removed from \`vite-hub/auth/server\`. Export \`useAuth\` instead, and call \`useAuth(event)\` in a route.`)
      kept = true
      continue
    }
    const replacement = name === "auth" ? `${useAuth}()` : useAuth
    // `typeof auth` names the instance type.
    if (parent?.type === "TSTypeQuery") overwrite(context, parent, name === "auth" ? `ReturnType<typeof ${useAuth}>` : `typeof ${useAuth}`)
    else if (parent?.type === "ObjectProperty" && parent.shorthand && parent.value === node) overwrite(context, parent, `${node.name}: ${replacement}`)
    else overwrite(context, node, replacement)
  }
  return !kept
}

/** `await isGitHubOrgMember(...)` becomes `!(await checkGitHubOrgMember(...))[0]`. */
function rewriteGitHub(context: FileContext) {
  const { program, block } = context
  const { named } = importsOf(program, rootModules, "isGitHubOrgMember")
  const check = localImport(program, rootModules, "checkGitHubOrgMember") ?? "checkGitHubOrgMember"
  for (const specifier of named) {
    let kept = false
    for (const { node, parent, grandparent } of references(context, specifier.local)) {
      if (parent?.type === "CallExpression" && parent.callee === node && grandparent?.type === "AwaitExpression") {
        const args = parent.arguments.map(argument => block.code.slice(start(argument), end(argument))).join(", ")
        overwrite(context, grandparent, `!(await ${check}(${args}))[0]`)
        continue
      }
      followUp(context, node, "`isGitHubOrgMember()` was removed. Call `checkGitHubOrgMember()`, which returns `[error]`: the membership is active when `error` is `undefined`. Throw on `AUTH_GITHUB_UNAVAILABLE` in `access.policy.allow`, so a GitHub outage does not end every session.")
      kept = true
    }
    if (!kept) replaceSpecifier(context, declarationOf(program, specifier), specifier, "checkGitHubOrgMember")
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
      const context: FileContext = { block, file, followUps, output, program, resolve: bindingResolver(program), added: new Map(), changed: 0 }
      rewriteServer(context)
      rewriteGitHub(context)
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
