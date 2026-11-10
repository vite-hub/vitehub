import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, isReference, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { CallExpression, File, Identifier, ImportDeclaration, MemberExpression, ObjectPattern } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** Exports that ViteHub renamed, by the module that exports them. */
const renamedExports = new Map<string, ReadonlyMap<string, string>>([
  ["@vite-hub/database/vite", new Map([["hubDb", "hubDatabase"]])],
  ["@vite-hub/database/nuxt", new Map([["hubDb", "hubDatabase"]])],
  ["@vite-hub/kv/vite", new Map([["hubKv", "hubKV"]])],
  ["@vite-hub/workspace/mountx", new Map([["createWorkspaceDriver", "createMountxDriver"]])],
  ["vite-hub/console/server", new Map([["console", "agentConsole"]])],
])

/** Modules that export `kv` or `blob`, whose `del()` became `delete()`. */
const storageModules = new Map([
  ["vite-hub/kv", "kv"],
  ["@vite-hub/kv", "kv"],
  ["vite-hub/blob", "blob"],
  ["@vite-hub/blob", "blob"],
])

/** Modules that export `deriveSecret()`. */
const secretModules = new Set(["#vitehub/env/server", "@vite-hub/env/server", "vite-hub/env/server", "vite-hub/env", "@vite-hub/env"])

/** Operation and Console MCP tool names that follow the method rename. */
const renamedStrings = new Map([
  ["kv.del", "kv.delete"],
  ["blob.del", "blob.delete"],
  ["kv_del", "kv_delete"],
  ["blob_del", "blob_delete"],
])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const envPatterns = [".env", ".env.*", ".dev.vars", "wrangler.toml", "wrangler.json", "wrangler.jsonc", "**/.env", "**/.env.*", "**/.dev.vars", "**/wrangler.toml", "**/wrangler.json", "**/wrangler.jsonc"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /\bhubDb\b|\bhubKv\b|\bcreateWorkspaceDriver\b|vite-hub\/console\/server|\b(?:kv|blob)[._]del\b|\.del\b|deriveSecret\(/

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
  resolveBinding: ReturnType<typeof bindingResolver>
  counts: Counts
}

interface Counts {
  exports: number
  deletes: number
  secrets: number
  strings: number
}

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(context.block.offset + start(node), context.block.offset + end(node), text)
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

/** Names that a variable, function, class, parameter, or catch clause declares in the block, except `binding`. */
function localDeclarations(program: File, binding?: Node): Set<string> {
  const declared = new Set<string>()
  const add = (pattern: Node | null | undefined) => {
    if (!pattern) return
    if (pattern.type === "Identifier") {
      if (pattern !== binding) declared.add(pattern.name)
    }
    else if (pattern.type === "AssignmentPattern") add(pattern.left)
    else if (pattern.type === "RestElement") add(pattern.argument)
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(add)
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property => add(property.type === "RestElement" ? property.argument : property.value))
    else if (pattern.type === "TSParameterProperty") add(pattern.parameter)
  }
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") add(node.id)
    else if (node.type === "CatchClause") add(node.param)
    else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" || node.type === "ClassMethod") {
      if ("id" in node) add(node.id)
      node.params.forEach(add)
    }
    else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") add(node.id)
  })
  return declared
}

/** The module of `import("x")` or `await import("x")`, or `undefined`. */
function importSource(node: Node | null | undefined): string | undefined {
  const value = node?.type === "AwaitExpression" ? node.argument : node
  if (value?.type === "ImportExpression" && value.source.type === "StringLiteral") return value.source.value
  if (value?.type === "CallExpression" && value.callee.type === "Import" && value.arguments[0]?.type === "StringLiteral") return value.arguments[0].value
  return undefined
}

/**
 * Renames every reference to a local binding. `binding` is the identifier that declares it in a destructuring
 * pattern. Returns false when the block declares the name again, so the codemod cannot tell the uses apart.
 */
function renameReferences(context: FileContext, from: string, to: string, declaration: Node, binding?: Node): boolean {
  if (localDeclarations(context.program, binding).has(from)) {
    followUp(context, declaration, `\`${from}\` is also declared in this file, so the codemod renamed only the import. Rename the uses of the import to \`${to}\` by hand.`)
    return false
  }
  walk(context.program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node === binding || !isReference(node, parent) || node.name !== from) return
    // `{ hubKv }` in an object literal and `export { hubKv }` keep their public names.
    if (parent?.type === "ObjectProperty" && parent.shorthand) overwrite(context, parent, `${from}: ${to}`)
    else if (parent?.type === "ExportSpecifier" && start(parent.exported) === start(node)) overwrite(context, parent, `${to} as ${from}`)
    else overwrite(context, node, to)
  })
  return true
}

/** Renames the imports and destructured dynamic imports of renamed exports. */
function rewriteExports(context: FileContext) {
  const { block, program } = context
  for (const statement of program.program.body) {
    if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source) {
      const renames = renamedExports.get(statement.source.value)
      if (!renames || statement.type === "ExportAllDeclaration") continue
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ExportSpecifier" || specifier.local.type !== "Identifier") continue
        const to = renames.get(specifier.local.name)
        if (!to) continue
        const exported = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
        // Keep the public name of the re-export, and read the renamed export.
        overwrite(context, specifier, exported === specifier.local.name ? `${to} as ${exported}` : `${to} as ${block.code.slice(start(specifier.exported), end(specifier.exported))}`)
        context.counts.exports++
      }
      continue
    }
    if (statement.type !== "ImportDeclaration") continue
    const renames = renamedExports.get(statement.source.value)
    if (!renames) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        followUp(context, specifier, `\`${statement.source.value}\` renamed ${[...renames].map(([from, to]) => `\`${from}\` to \`${to}\``).join(" and ")}. Update reads through this namespace import by hand.`)
        continue
      }
      const name = importedName(specifier)
      const to = name ? renames.get(name) : undefined
      if (!to || specifier.type !== "ImportSpecifier") continue
      context.counts.exports++
      if (specifier.local.name !== name) {
        overwrite(context, specifier.imported, to)
        continue
      }
      overwrite(context, specifier, renameReferences(context, name, to, specifier) ? to : `${to} as ${name}`)
    }
  }

  // `const { hubKv } = await import("@vite-hub/kv/vite")`, as a Vite config that loads a plugin on demand does.
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "ObjectPattern") return
    const source = importSource(node.init)
    const renames = source ? renamedExports.get(source) : undefined
    if (renames) rewritePattern(context, node.id, renames)
  })
  // `Promise.all([import(...), ...])` destructured as `[{ hubKv }, ...]`.
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "ArrayPattern") return
    const init = node.init?.type === "AwaitExpression" ? node.init.argument : node.init
    if (init?.type !== "CallExpression" || init.arguments[0]?.type !== "ArrayExpression") return
    const imports = init.arguments[0].elements
    node.id.elements.forEach((element, index) => {
      if (element?.type !== "ObjectPattern") return
      const source = importSource(imports[index])
      const renames = source ? renamedExports.get(source) : undefined
      if (renames) rewritePattern(context, element, renames)
    })
  })
}

function rewritePattern(context: FileContext, pattern: ObjectPattern, renames: ReadonlyMap<string, string>) {
  for (const property of pattern.properties) {
    if (property.type !== "ObjectProperty" || property.computed || property.key.type !== "Identifier") continue
    const from = property.key.name
    const to = renames.get(from)
    if (!to) continue
    context.counts.exports++
    if (!property.shorthand) {
      overwrite(context, property.key, to)
      continue
    }
    overwrite(context, property, renameReferences(context, from, to, property, property.value) ? to : `${to}: ${from}`)
  }
}

/** Declarations of `kv` and `blob` imports in the block. */
function storageBindings(program: File): Set<Identifier> {
  const names = new Set<Identifier>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    const exported = storageModules.get(statement.source.value)
    if (!exported) continue
    for (const specifier of statement.specifiers) {
      if (importedName(specifier) === exported) names.add(specifier.local)
    }
  }
  return names
}

/** True for `kv`, `blob`, or a `kv.store(...)` handle of an imported binding. */
function isStorage(node: Node, names: ReadonlySet<Identifier>, resolveBinding: FileContext["resolveBinding"]): boolean {
  if (node.type === "Identifier") {
    const binding = resolveBinding(node)
    return binding !== undefined && names.has(binding)
  }
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed
    && node.callee.property.type === "Identifier" && node.callee.property.name === "store") return isStorage(node.callee.object, names, resolveBinding)
  return false
}

function isDelMember(node: Node): node is MemberExpression {
  return (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed
    && node.property.type === "Identifier" && node.property.name === "del"
}

/** Renames `kv.del()`, `blob.del()`, and `kv.store(name).del()`. Lists other `.del()` calls in a file that uses them. */
function rewriteDeletes(context: FileContext) {
  const names = storageBindings(context.program)
  if (!names.size) return
  walk(context.program, (node) => {
    if (!isDelMember(node)) return
    if (isStorage(node.object, names, context.resolveBinding)) {
      overwrite(context, node.property, "delete")
      context.counts.deletes++
      return
    }
    followUp(context, node, "ViteHub KV and Blob renamed `del()` to `delete()`. If this calls a KV or Blob handle, rename it.")
  })
}

/** Turns `deriveSecret(purpose, event)` into `deriveSecret(purpose, { event })`. */
function rewriteSecrets(context: FileContext) {
  const names = new Set<Identifier>()
  for (const statement of context.program.program.body) {
    if (statement.type !== "ImportDeclaration" || !secretModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (importedName(specifier) === "deriveSecret") names.add(specifier.local)
    }
  }
  if (!names.size) return
  walk(context.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
    const binding = context.resolveBinding(node.callee)
    if (!binding || !names.has(binding)) return
    rewriteSecretCall(context, node)
  })
}

function rewriteSecretCall(context: FileContext, call: CallExpression) {
  const { block } = context
  const [, second, ...rest] = call.arguments
  if (!second || second.type === "ObjectExpression") return
  if (rest.length || second.type === "SpreadElement" || second.type === "ArgumentPlaceholder") {
    followUp(context, call, "`deriveSecret()` takes `(purpose, { event, root })`. Move the event and the root secret into the options object.")
    return
  }
  context.counts.secrets++
  if (second.type === "Identifier" && second.name === "undefined") {
    context.output.remove(block.offset + end(call.arguments[0]!), block.offset + end(second))
    return
  }
  const source = block.code.slice(start(second), end(second))
  overwrite(context, second, second.type === "Identifier" && second.name === "event" ? "{ event }" : `{ event: ${source} }`)
}

/** Renames the operation and Console MCP tool names in string literals, such as a client allowlist. */
function rewriteStrings(context: FileContext) {
  const { block } = context
  walk(context.program, (node) => {
    if (node.type !== "StringLiteral") return
    const to = renamedStrings.get(node.value)
    if (!to) return
    const quote = block.code[start(node)] === "'" ? "'" : "\""
    overwrite(context, node, `${quote}${to}${quote}`)
    context.counts.strings++
  })
}

/** Lists env and Wrangler files that set `NUXT_APP_SECRET`, which ViteHub no longer reads. It never prints values. */
async function appSecretFollowUps(cwd: string): Promise<FollowUp[]> {
  const files = (await glob(envPatterns, { cwd, ignore: ignoredPatterns, dot: true })).sort()
  const followUps: FollowUp[] = []
  for (const file of files) {
    const text = await readFile(join(cwd, file), "utf8").catch(() => "")
    if (/\bVITEHUB_SECRET\b/.test(text)) continue
    const index = text.search(/\bNUXT_APP_SECRET\b/)
    if (index < 0) continue
    followUps.push({
      file,
      line: text.slice(0, index).split("\n").length,
      message: "ViteHub no longer reads `NUXT_APP_SECRET`. Set `VITEHUB_SECRET` to the same value, here and in each deployment.",
    })
  }
  return followUps
}

/** Lists `package.json` scripts that call `vitehub kv del` or `vitehub blob del`. */
async function scriptFollowUps(cwd: string): Promise<FollowUp[]> {
  const text = await readFile(join(cwd, "package.json"), "utf8").catch(() => "")
  return text.split("\n").flatMap((value, index) => /\bvitehub (?:kv|blob) del\b/.test(value)
    ? [{ file: "package.json", line: index + 1, message: "`vitehub kv del` and `vitehub blob del` are now `vitehub kv delete` and `vitehub blob delete`." }]
    : [])
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const counts: Counts = { deletes: 0, exports: 0, secrets: 0, strings: 0 }

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
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Rename its ViteHub APIs by hand.` })
        continue
      }
      const context: FileContext = { block, counts, file, followUps, output, program, resolveBinding: bindingResolver(program) }
      rewriteExports(context)
      rewriteDeletes(context)
      rewriteSecrets(context)
      rewriteStrings(context)
    }
    if (output.hasChanged()) edits.push({ path: file, before: source, after: output.toString() })
  }

  followUps.push(...await appSecretFollowUps(cwd), ...await scriptFollowUps(cwd))
  const notes = [
    ...(counts.exports ? [`Renamed ${counts.exports} import(s) of \`hubDb\`, \`hubKv\`, \`createWorkspaceDriver\`, or \`console\`.`] : []),
    ...(counts.deletes ? [`Renamed ${counts.deletes} \`del()\` call(s) on KV and Blob to \`delete()\`.`] : []),
    ...(counts.secrets ? [`Moved the event of ${counts.secrets} \`deriveSecret()\` call(s) into \`{ event }\`.`] : []),
    ...(counts.strings ? [`Renamed ${counts.strings} operation or MCP tool name(s) from \`del\` to \`delete\`.`] : []),
  ]
  return {
    summary: edits.length ? `renamed the ViteHub APIs of ${edits.length} file(s)` : "found no renamed ViteHub API",
    edits,
    followUps,
    notes,
    nextSteps: edits.length ? ["Run your typecheck."] : [],
  }
}

const detections: [RegExp, string][] = [
  [/\bhubDb\b/, "hubDb"],
  [/\bhubKv\b/, "hubKv"],
  [/\bcreateWorkspaceDriver\b/, "createWorkspaceDriver"],
  [/\b(?:kv|blob)\.del\(/, "del()"],
  [/\bderiveSecret\([^),]+,/, "deriveSecret() with a positional event"],
]

export const renamedApis: Codemod = {
  name: "renamed-apis",
  description: "Rename hubDb, hubKv, createWorkspaceDriver, kv.del(), blob.del(), and the positional deriveSecret() event",
  usage: "[dir]",
  async detect({ cwd }) {
    // Reuse the edit planner so detection covers every supported migration form.
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) {
      const match = detections.find(([pattern]) => pattern.test(edit.before ?? ""))
      return { reason: `${edit.path} uses ${match?.[1] ?? "renamed ViteHub APIs"}` }
    }
    const [followUp] = result.followUps
    if (followUp) return { reason: `${followUp.file} needs a ViteHub API migration` }
    return undefined
  },
  run: migrate,
}
