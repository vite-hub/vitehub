import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, isReference, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { blockBindings } from "../shared/bindings.ts"

import type { File, Identifier, ObjectPattern } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const shellModules = ["@vite-hub/shell", "vite-hub/shell"]
const justBashModules = ["@vite-hub/shell/providers/just-bash", "vite-hub/shell/providers/just-bash"]
const workspaceModules = ["@vite-hub/workspace", "vite-hub/workspace"]

/** Shell exports that say driver now, by the module that exports them. */
const renamedExports = new Map<string, ReadonlyMap<string, string>>([
  ...shellModules.map(source => [source, new Map([["ShellExecutionProvider", "ShellDriver"]])] as const),
  ...justBashModules.map(source => [source, new Map([
    ["createJustBashProvider", "createJustBashDriver"],
    ["JustBashProviderOptions", "JustBashDriverOptions"],
  ])] as const),
])

interface RenamedKey {
  name: string
  sources: readonly string[]
  /** The index of the options object in the call. */
  argument: number
  from: string
  to: string
}

/** Calls whose options object renamed the key that selects the Shell driver. */
const renamedKeys: readonly RenamedKey[] = [
  { name: "createShellRuntime", sources: shellModules, argument: 0, from: "provider", to: "driver" },
  { name: "createWorkspaceTools", sources: workspaceModules, argument: 1, from: "executionProvider", to: "shellDriver" },
]

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /\bShellExecutionProvider\b|\bcreateJustBashProvider\b|\bJustBashProviderOptions\b|\bcreateShellRuntime\b|\bexecutionProvider\b/

interface Imported {
  source: string
  /** The exported name, or `undefined` for a namespace import. */
  name?: string
}

interface FileContext {
  code: string
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  resolve: ReturnType<typeof bindingResolver>
  /** The import of each local declaration, by its declaring identifier. */
  imports: Map<Identifier, Imported>
  /** Every name that the file declares, in any scope. A new name that is in it keeps the old local name. */
  declared: Set<string>
  changed: number
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(start(node), end(node), text)
  context.changed++
}

function importSource(node: Node | null | undefined): string | undefined {
  const value = node?.type === "AwaitExpression" ? node.argument : node
  if (value?.type === "ImportExpression" && value.source.type === "StringLiteral") return value.source.value
  if (value?.type === "CallExpression" && value.callee.type === "Import" && value.arguments[0]?.type === "StringLiteral") return value.arguments[0].value
  return undefined
}

/** Static imports, and `const { name } = await import(...)` or `const module = await import(...)`. */
function collectImports(program: File): Map<Identifier, Imported> {
  const imports = new Map<Identifier, Imported>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    const source = statement.source.value
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") imports.set(specifier.local, { source })
      else if (specifier.type === "ImportSpecifier") imports.set(specifier.local, { source, name: keyName(specifier.imported) })
    }
  }
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator") return
    const source = importSource(node.init)
    if (!source) return
    if (node.id.type === "Identifier") imports.set(node.id, { source })
    if (node.id.type !== "ObjectPattern") return
    for (const property of node.id.properties) {
      if (property.type !== "ObjectProperty" || property.computed) continue
      const local = property.value.type === "AssignmentPattern" ? property.value.left : property.value
      if (local.type === "Identifier") imports.set(local, { source, name: keyName(property.key) })
    }
  })
  return imports
}

function declaredNames(program: File): Set<string> {
  const names = new Set(blockBindings(program).keys())
  walk(program, (node) => {
    if (node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") names.add(node.id.name)
  })
  return names
}

/** Renames every reference that resolves to `binding`. Shorthand properties and local exports keep their old names. */
function renameReferences(context: FileContext, binding: Identifier, to: string) {
  const from = binding.name
  walk(context.program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node === binding || node.type !== "Identifier" || node.name !== from || !isReference(node, parent)) return
    if (context.resolve(node) !== binding) return
    if (parent?.type === "ObjectProperty" && parent.shorthand) overwrite(context, parent, `${from}: ${to}`)
    else if (parent?.type === "ExportSpecifier" && start(parent.exported) === start(node)) overwrite(context, parent, `${to} as ${from}`)
    else overwrite(context, node, to)
  })
}

/** Renames imports, re-exports, namespace reads, and destructured dynamic imports of the renamed Shell exports. */
function rewriteExports(context: FileContext) {
  const { program } = context
  for (const statement of program.program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.source) {
      const renames = renamedExports.get(statement.source.value)
      if (!renames) continue
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ExportSpecifier") continue
        const to = renames.get(keyName(specifier.local) ?? "")
        if (!to) continue
        const exported = context.code.slice(start(specifier.exported), end(specifier.exported))
        overwrite(context, specifier, `${to} as ${exported}`)
      }
      continue
    }
    if (statement.type !== "ImportDeclaration") continue
    const renames = renamedExports.get(statement.source.value)
    if (!renames) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue
      const to = renames.get(keyName(specifier.imported) ?? "")
      if (!to) continue
      if (specifier.local.name !== keyName(specifier.imported)) {
        overwrite(context, specifier.imported, to)
        continue
      }
      // The imported and local names share one range. Overwrite it once, after the `type` modifier.
      const from = specifier.local.name
      context.output.overwrite(start(specifier.local), end(specifier.local), context.declared.has(to) ? `${to} as ${from}` : to)
      context.changed++
      if (!context.declared.has(to)) renameReferences(context, specifier.local, to)
    }
  }

  walk(program, (node) => {
    // `shell.createJustBashProvider()` and `Shell.ShellExecutionProvider` through a namespace import.
    const namespace = node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" ? { object: node.object, property: node.property }
      : node.type === "TSQualifiedName" && node.left.type === "Identifier" ? { object: node.left, property: node.right }
        : undefined
    if (namespace && namespace.property.type === "Identifier") {
      const binding = context.resolve(namespace.object)
      const imported = binding ? context.imports.get(binding) : undefined
      const to = imported && !imported.name ? renamedExports.get(imported.source)?.get(namespace.property.name) : undefined
      if (to) overwrite(context, namespace.property, to)
      return
    }
    // `const { createJustBashProvider } = await import("vite-hub/shell/providers/just-bash")`.
    if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern") {
      const source = importSource(node.init)
      const renames = source ? renamedExports.get(source) : undefined
      if (renames) rewritePattern(context, node.id, renames)
    }
  })
}

function rewritePattern(context: FileContext, pattern: ObjectPattern, renames: ReadonlyMap<string, string>) {
  for (const property of pattern.properties) {
    if (property.type !== "ObjectProperty" || property.computed || property.key.type !== "Identifier") continue
    const to = renames.get(property.key.name)
    if (!to) continue
    if (!property.shorthand || property.value.type !== "Identifier") {
      overwrite(context, property.key, to)
      continue
    }
    if (context.declared.has(to)) {
      overwrite(context, property, `${to}: ${property.value.name}`)
      continue
    }
    overwrite(context, property, to)
    renameReferences(context, property.value, to)
  }
}

/** The renamed-key entry of a call to an imported `createShellRuntime()` or `createWorkspaceTools()`. */
function renamedKeyOf(context: FileContext, callee: Node): RenamedKey | undefined {
  const local = callee.type === "Identifier" ? callee
    : callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" ? callee.object : undefined
  const binding = local ? context.resolve(local) : undefined
  const imported = binding ? context.imports.get(binding) : undefined
  if (!imported) return undefined
  const name = imported.name ?? (callee.type === "MemberExpression" ? keyName(callee.property, callee.computed) : undefined)
  return renamedKeys.find(entry => entry.name === name && entry.sources.includes(imported.source))
}

/** Renames `provider` in `createShellRuntime({ provider })` and `executionProvider` in `createWorkspaceTools(input, { executionProvider })`. */
function rewriteKeys(context: FileContext) {
  walk(context.program, (node) => {
    if (node.type !== "CallExpression") return
    const entry = renamedKeyOf(context, node.callee)
    if (!entry) return
    const options = node.arguments[entry.argument]
    if (!options) return
    if (options.type !== "ObjectExpression") {
      context.followUps.push({ file: context.file, line: line(options), message: `Shell renamed \`${entry.from}\` to \`${entry.to}\`. Rename it in the options that this \`${entry.name}()\` call gets.` })
      return
    }
    for (const property of options.properties) {
      if (property.type === "SpreadElement") {
        context.followUps.push({ file: context.file, line: line(property), message: `Shell renamed \`${entry.from}\` to \`${entry.to}\`. Rename it in the object that this \`${entry.name}()\` call spreads.` })
        continue
      }
      if (property.type !== "ObjectProperty" || keyName(property.key, property.computed) !== entry.from) continue
      if (property.shorthand) overwrite(context, property, `${entry.to}: ${context.code.slice(start(property.value), end(property.value))}`)
      // `{ ["provider"]: driver }` and `{ "provider": driver }` keep their quotes, so the key stays a string.
      else if (property.key.type === "StringLiteral") overwrite(context, property.key, `${context.code[start(property.key)]}${entry.to}${context.code[start(property.key)]}`)
      else overwrite(context, property.key, entry.to)
    }
  })
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of files) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!needle.test(code)) continue
    let program: File
    try {
      program = parseProgram(code, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) })
    }
    catch (error) {
      followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Rename the Shell \`provider\` names to \`driver\` by hand.` })
      continue
    }
    const context: FileContext = { code, file, followUps, output: new MagicString(code), program, resolve: bindingResolver(program), imports: collectImports(program), declared: declaredNames(program), changed: 0 }
    rewriteExports(context)
    rewriteKeys(context)
    if (context.changed) edits.push({ path: file, before: code, after: context.output.toString() })
  }
  return {
    summary: edits.length ? `renamed the Shell provider to driver in ${edits.length} file(s)` : "found no Shell provider",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length ? ["Run your typecheck."] : [],
  }
}

export const shellDriver: Codemod = {
  name: "shell-driver",
  description: "Rename the Shell provider to driver: createShellRuntime({ driver }), ShellDriver, createJustBashDriver(), and createWorkspaceTools({ shellDriver })",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} uses the Shell \`provider\` names` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs the Shell \`driver\` rename` } : undefined
  },
  run: migrate,
}
