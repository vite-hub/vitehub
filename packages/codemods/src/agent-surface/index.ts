import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, findProperty, isReference, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { blockBindings } from "../shared/bindings.ts"
import { readDependencies } from "../shared/detect.ts"

import type { CallExpression, File, Identifier, ImportDeclaration, ObjectExpression, ObjectProperty, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const roots = new Set(["vite-hub/agent", "@vite-hub/agent"])

/** Agent subpaths that merged into one entry. */
const movedSubpaths = new Map([
  ["process-host", "process"],
  ["runtime/process", "process"],
  ["invocations/d1", "invocations"],
  ["invocations/sqlite", "invocations"],
  ["state/sqlite", "state"],
])

/** Root exports with a new name. */
const renamedExports = new Map([
  ["AgentActor", "AgentInvoker"],
  ["AgentInvokerProfile", "AgentInvoker"],
  ["getAgentFromRegistry", "loadAgent"],
  ["workflow", "agentWorkflow"],
])

const internalHelper = (name: string) => `\`${name}\` is no longer exported from the Agent root. It was an internal helper; remove the import or copy what you need.`
const removedExports = new Map<string, string>([
  ["getAgent", "`getAgent()` was removed. Use `loadAgent(name)` to load a discovered Agent Definition, and `runAgent()` or `streamAgent()` to run it."],
  ["agentChatContextKey", "`agentChatContextKey` is no longer exported from the Agent root. Import it from `vite-hub/agent/capabilities`."],
  ["getAgentChatContext", "`getAgentChatContext` is no longer exported from the Agent root. Import it from `vite-hub/agent/capabilities`."],
  ...[
    "agentInvocationStreamRoute", "agentInvokerContextKey", "appendMessageText", "applyAgentToolPolicies", "applyStreamEvent",
    "arrayBufferByteLength", "attachmentStringByteLength", "attachmentStringBytes", "blobArrayBuffer", "blobSize", "blobType",
    "collectStreamEvents", "createAgentChatData", "createAgentInspectionMetadata", "currentInputAttachments", "getToolInvocations",
    "isArrayBufferValue", "isAttachmentBlob", "isAttachmentData", "isBlobValue", "isResolvedAgentTriggerHandledInvocation",
    "isTextAttachmentMediaType", "isUint8ArrayValue", "materializeAgentInspectionSourceMetadata", "materializeMessageAttachmentData",
    "memoizeMessageAttachmentData", "registerResponseConstructor", "reserveAgentChannelItem", "resolveAgent",
    "resolveAgentInspectionMetadata", "resolveAgentTriggers", "uint8ArrayByteLength", "validateMessage", "verifyAgentWebhookRequest",
    "withAgentToolStepReporting", "workspaceAgentOwnsWorkspaceDefinition", "workspaceDefinitionFromOptions",
  ].map(name => [name, internalHelper(name)] as const),
])

const removedSubpaths = new Map([
  ["invocations/default", "`@vite-hub/agent/invocations/default` is private now. Agents get the default Invocation Journal from `vitehub({ agent })`; pick a store from `vite-hub/agent/invocations` to replace it."],
])

/** `defineAgent()` callbacks whose first parameter had an `actor` field. */
const definitionCalls = new Set(["defineAgent", "defineCapability", "defineAgentInvoker"])
const providerKinds = new Set(["state", "scheduler", "sandbox"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needles = /AgentActor|AgentInvokerProfile|getAgentFromRegistry|\bgetAgent\b|agent\/(?:process-host|runtime\/process|invocations\/(?:d1|sqlite|default)|state\/sqlite)|\bpresets?\b|\bproviders\s*:|\bactor\b|\bworkflow\b/

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
    return [{ code: block.content, offset: block.loc.start.offset, lineOffset: block.loc.start.line - 1, jsx: lang === "tsx" || lang === "jsx", typescript: lang === "ts" || lang === "tsx" }]
  })
}

interface FileContext {
  block: Block
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  style: CodeStyle
  resolveBinding: ReturnType<typeof bindingResolver>
  imports: Map<Identifier, { source: string, name?: string }>
}

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(context.block.offset + start(node), context.block.offset + end(node), text)
}

function remove(context: FileContext, node: Node) {
  const [from, to] = listItemRemoval(context.block.code, node)
  context.output.remove(context.block.offset + from, context.block.offset + to)
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return keyName(specifier.imported)
}

/** The new module path of an old Agent subpath, such as `vite-hub/agent/state/sqlite` to `vite-hub/agent/state`. */
function movedSource(source: string): string | undefined {
  for (const root of roots) {
    if (!source.startsWith(`${root}/`)) continue
    const target = movedSubpaths.get(source.slice(root.length + 1))
    if (target) return `${root}/${target}`
  }
  return undefined
}

function removedSource(source: string): string | undefined {
  for (const root of roots) {
    if (source.startsWith(`${root}/`)) return removedSubpaths.get(source.slice(root.length + 1))
  }
  return undefined
}

/**
 * Renames reads of an imported binding. Returns false when the file declares either name elsewhere, so a manual check is
 * safer. `importsTarget` is true when the same import already brings in `to`.
 */
function renameReferences(context: FileContext, from: string, to: string, bindings: Map<string, Node[]>, importsTarget: boolean): boolean {
  if ((bindings.get(from)?.length ?? 0) > 1 || (bindings.get(to)?.length ?? 0) > (importsTarget ? 1 : 0)) return false
  walk(context.program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (node.type === "Identifier" && node.name === from && (isReference(node, parent) || parent?.type === "TSTypeReference" || parent?.type === "TSQualifiedName" || parent?.type === "TSTypeQuery")) {
      if (parent?.type === "ObjectProperty" && parent.shorthand) overwrite(context, parent, `${from}: ${to}`)
      else overwrite(context, node, to)
    }
  })
  return true
}

/** Rewrites the imports and re-exports of one block. Returns the local names of `defineAgent`-like calls. */
function rewriteImports(context: FileContext, bindings: Map<string, Node[]>): { definitionLocals: Set<string>, hubAgentLocals: Set<string>, importsAgent: boolean } {
  const definitionLocals = new Set<string>()
  const hubAgentLocals = new Set<string>()
  let importsAgent = false
  const merged = new Map<string, ImportDeclaration>()
  for (const statement of context.program.program.body) {
    if (statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") {
      const source = statement.source
      if (!source) continue
      const removed = removedSource(source.value)
      if (removed) followUp(context, statement, removed)
      const moved = movedSource(source.value)
      if (moved && statement.type === "ImportDeclaration") {
        importsAgent = true
        // Two old paths, such as `invocations/d1` and `invocations/sqlite`, can land on the same entry.
        const key = `${statement.importKind ?? "value"}:${moved}`
        const target = merged.get(key)
        if (target && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")) {
          const names = statement.specifiers.map(specifier => context.block.code.slice(start(specifier), end(specifier))).join(", ")
          context.output.appendLeft(context.block.offset + end(target.specifiers.at(-1)!), `, ${names}`)
          remove(context, statement)
          continue
        }
        if (statement.specifiers.length && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")) merged.set(key, statement)
        overwrite(context, source, quoteString(moved, context.style))
        continue
      }
      if (moved) {
        overwrite(context, source, quoteString(moved, context.style))
        continue
      }
      if (statement.type === "ImportDeclaration" && source.value.endsWith("/vite") && roots.has(source.value.slice(0, -"/vite".length))) {
        for (const specifier of statement.specifiers) if (importedName(specifier) === "hubAgent") hubAgentLocals.add(specifier.local.name)
      }
      if (!roots.has(source.value)) continue
      importsAgent = true
      if (statement.type === "ImportDeclaration") rewriteRootImport(context, statement, bindings, definitionLocals)
      else if (statement.type === "ExportNamedDeclaration") {
        for (const specifier of statement.specifiers) {
          if (specifier.type !== "ExportSpecifier") continue
          const name = keyName(specifier.local)
          const renamed = name ? renamedExports.get(name) : undefined
          if (renamed) followUp(context, specifier, `\`${name}\` is now \`${renamed}\`. Update this re-export and its importers.`)
          const removedMessage = name ? removedExports.get(name) : undefined
          if (removedMessage) followUp(context, specifier, removedMessage)
        }
      }
    }
  }
  return { definitionLocals, hubAgentLocals, importsAgent }
}

function rewriteRootImport(context: FileContext, statement: ImportDeclaration, bindings: Map<string, Node[]>, definitionLocals: Set<string>) {
  const kept = new Set(statement.specifiers.flatMap(specifier => specifier.type === "ImportSpecifier" ? [specifier.local.name] : []))
  for (const specifier of statement.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier") {
      rewriteNamespaceReads(context, specifier.local)
      continue
    }
    const name = importedName(specifier)
    if (!name || specifier.type !== "ImportSpecifier") continue
    if (definitionCalls.has(name)) definitionLocals.add(specifier.local.name)
    const removedMessage = removedExports.get(name)
    if (removedMessage) {
      followUp(context, specifier, removedMessage)
      continue
    }
    const renamed = renamedExports.get(name)
    if (!renamed) continue
    const typePrefix = specifier.importKind === "type" ? "type " : ""
    if (specifier.local.name !== name) {
      // `workflow as agentWorkflow` keeps its local name.
      overwrite(context, specifier, specifier.local.name === renamed ? `${typePrefix}${renamed}` : `${typePrefix}${renamed} as ${specifier.local.name}`)
      continue
    }
    if (!renameReferences(context, name, renamed, bindings, kept.has(renamed))) {
      if (kept.has(renamed)) {
        followUp(context, specifier, `\`${name}\` is now \`${renamed}\`, which this file already declares. Replace the reads of \`${name}\` by hand.`)
        continue
      }
      overwrite(context, specifier, `${typePrefix}${renamed} as ${name}`)
      followUp(context, specifier, `\`${name}\` is now \`${renamed}\`. The file declares \`${name}\` more than once, so the codemod kept it as a local alias.`)
      continue
    }
    if (kept.has(renamed)) remove(context, specifier)
    else {
      overwrite(context, specifier, `${typePrefix}${renamed}`)
      kept.add(renamed)
    }
  }
}

function rewriteNamespaceReads(context: FileContext, namespace: Identifier) {
  walk(context.program, (node) => {
    if (node.type !== "MemberExpression" && node.type !== "TSQualifiedName") return
    const object = node.type === "MemberExpression" ? node.object : node.left
    const property = node.type === "MemberExpression" ? (node.computed ? undefined : node.property) : node.right
    if (object.type !== "Identifier" || context.resolveBinding(object) !== namespace || property?.type !== "Identifier") return
    const renamed = renamedExports.get(property.name)
    if (renamed) overwrite(context, property, renamed)
    const removedMessage = removedExports.get(property.name)
    if (removedMessage) followUp(context, node, removedMessage)
  })
}

function isCallTo(context: FileContext, node: Node, locals: ReadonlySet<string>): node is CallExpression {
  return node.type === "CallExpression" && node.callee.type === "Identifier" && locals.has(node.callee.name)
    && context.imports.has(context.resolveBinding(node.callee)!)
}

function importedCall(context: FileContext, node: Node): { source: string, name?: string } | undefined {
  if (node.type !== "CallExpression") return undefined
  if (node.callee.type === "Identifier") return context.imports.get(context.resolveBinding(node.callee)!)
  if (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.type === "Identifier" && node.callee.property.type === "Identifier") {
    const imported = context.imports.get(context.resolveBinding(node.callee.object)!)
    if (imported && (!imported.name || (imported.source === "vitest" && ["vi", "vitest"].includes(imported.name)))) return { source: imported.source, name: node.callee.property.name }
  }
  return undefined
}

function propertyNamed(object: ObjectExpression, name: string): ObjectProperty | undefined {
  return findProperty(object, name)
}

/** `defineAgent({ preset: "x", presets: { x } })` becomes `defineAgent({ extends: x })`. */
function rewritePresetSelection(context: FileContext, definitionLocals: ReadonlySet<string>) {
  walk(context.program, (node) => {
    if (!isCallTo(context, node, definitionLocals)) return
    const options = node.arguments[0]
    if (options?.type !== "ObjectExpression") return
    const preset = propertyNamed(options, "preset")
    const presets = propertyNamed(options, "presets")
    if (!preset && !presets) return
    const message = "`defineAgent()` has no `preset` or `presets` option. Pass the parent Agent Definition as `extends`."
    if (!preset || !presets || preset.value.type !== "StringLiteral" || presets.value.type !== "ObjectExpression" || propertyNamed(options, "extends")) {
      followUp(context, preset ?? presets!, message)
      return
    }
    const selected = propertyNamed(presets.value, (preset.value as StringLiteral).value)
    if (!selected || selected.value.type === "AssignmentPattern" || selected.value.type === "RestElement") {
      followUp(context, preset, message)
      return
    }
    const parent = context.block.code.slice(start(selected.value), end(selected.value))
    overwrite(context, preset, `extends: ${parent}`)
    remove(context, presets)
  })
}

/** `providers: { state: { provider: "libsql" } }` becomes `providers: { state: { driver: "libsql" } }` in Agent options. */
function rewriteProviderKeys(context: FileContext, hubAgentLocals: ReadonlySet<string>) {
  walk(context.program, (node, ancestors) => {
    if (node.type !== "ObjectProperty" || keyName(node.key, node.computed) !== "providers" || node.value.type !== "ObjectExpression") return
    const owner = ancestors.at(-1)
    const ownerParent = ancestors.at(-2)
    const config = ancestors.at(-3)
    const call = ancestors.at(-4)
    const imported = call && importedCall(context, call)
    const agentOptions = (ownerParent?.type === "ObjectProperty" && keyName(ownerParent.key, ownerParent.computed) === "agent" && ownerParent.value === owner
      && call?.type === "CallExpression" && call.arguments[0] === config && imported?.source === "vite-hub" && imported.name === "vitehub")
      || (ownerParent !== undefined && isCallTo(context, ownerParent, hubAgentLocals) && ownerParent.arguments[0] === owner)
    for (const entry of node.value.properties) {
      if (entry.type !== "ObjectProperty" || !providerKinds.has(keyName(entry.key, entry.computed) ?? "") || entry.value.type !== "ObjectExpression") continue
      const provider = propertyNamed(entry.value, "provider")
      if (!provider) continue
      if (!agentOptions) {
        followUp(context, provider, "If these are Agent provider options, replace `provider` with `driver`; the codemod could not prove the configuration owner.")
        continue
      }
      if (provider.shorthand) overwrite(context, provider, "driver: provider")
      else overwrite(context, provider.key, "driver")
    }
  })
}

const agentContextKeys = new Set(["capabilities", "capability", "context", "input", "invoker", "messages", "run", "runtime", "trigger", "workspace"])
const callbackNames = new Set(["run", "prepare", "resolve", "input", "output", "intercept", "instructions", "capabilities", "workspace", "tools", "finish"])

/** Only direct callback properties of a Definition receive its context. Nested application functions do not. */
function agentCallback(context: FileContext, ancestors: readonly Node[], definitionLocals: ReadonlySet<string>) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const fn = ancestors[index]!
    if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression" && fn.type !== "ObjectMethod") continue
    const property = fn.type === "ObjectMethod" ? fn : ancestors[index - 1]
    if (property?.type !== "ObjectProperty" && property?.type !== "ObjectMethod") continue
    const name = keyName(property.key, property.computed)
    if (!name || (!callbackNames.has(name) && !name.startsWith("agent:") && !name.startsWith("tool:"))) continue
    for (let outer = index - 1; outer >= 0; outer--) {
      const node = ancestors[outer]!
      if (isCallTo(context, node, definitionLocals)) return node.arguments[0] === ancestors[outer + 1] ? fn : undefined
      if (node.type !== "ObjectExpression" && node.type !== "ObjectProperty" && node.type !== "ArrayExpression") break
    }
  }
  return undefined
}

function callbackContext(context: FileContext, object: Node, first: Node | undefined, carrier: boolean): boolean {
  if (object.type === "Identifier" && first?.type === "Identifier") return carrier && context.resolveBinding(object) === first
  if (object.type === "Identifier" && first?.type === "ObjectPattern" && !carrier) {
    const property = first.properties.find(property => property.type === "ObjectProperty" && keyName(property.key, property.computed) === "context")
    return property?.type === "ObjectProperty" && property.value.type === "Identifier" && context.resolveBinding(object) === property.value
  }
  return !carrier && object.type === "MemberExpression" && !object.computed && object.property.type === "Identifier" && object.property.name === "context"
    && callbackContext(context, object.object, first, true)
}

/** The `actor` field of Agent contexts and inputs is now `invoker`. */
function rewriteActor(context: FileContext, definitionLocals: ReadonlySet<string>) {
  walk(context.program, (node, ancestors) => {
    const callback = agentCallback(context, ancestors, definitionLocals)
    const first = callback?.params[0]
    if (node.type === "ObjectProperty" && keyName(node.key, node.computed) === "actor") {
      const owner = ancestors.at(-1)
      const ownerProperty = ancestors.at(-2)
      if (owner?.type === "ObjectExpression" && ownerProperty?.type === "ObjectProperty" && keyName(ownerProperty.key, ownerProperty.computed) === "context") {
        const input = ancestors.at(-3)
        const call = ancestors.at(-4)
        const imported = call && importedCall(context, call)
        const position = call?.type === "CallExpression" ? call.arguments.findIndex(argument => argument === input) : -1
        const invocation = imported && roots.has(imported.source)
          && ((["runAgent", "streamAgent"].includes(imported.name ?? "") && (position === 1 || position === 2))
            || (["startAgentInvocation", "runAgentInline", "streamAgentInline"].includes(imported.name ?? "") && position === 2))
        if (!invocation) {
          followUp(context, node, "If this is an Agent Invocation input, replace `context.actor` with `context.invoker`; the codemod could not prove the call site.")
          return
        }
        if (propertyNamed(owner, "invoker")) remove(context, node)
        else overwrite(context, node, node.shorthand ? "invoker: actor" : `invoker: ${context.block.code.slice(start(node.value), end(node.value))}`)
        return
      }
      if (owner?.type === "ObjectPattern" && owner === first) {
        const keys = owner.properties.flatMap(property => property.type === "ObjectProperty" ? [keyName(property.key, property.computed)] : [])
        const message = "Agent callbacks no longer receive `actor`. It was the same value as `invoker`; read `invoker` instead."
        if (keys.includes("invoker") || !keys.some(key => key !== undefined && agentContextKeys.has(key))) followUp(context, node, message)
        else overwrite(context, node.key, node.shorthand ? "invoker: actor" : "invoker")
      }
      return
    }
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === "actor"
      && callbackContext(context, node.object, first, true)) {
      overwrite(context, node.property, "invoker")
      return
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier" && node.callee.property.name === "get"
      && node.arguments[0]?.type === "StringLiteral" && node.arguments[0].value === "actor" && callbackContext(context, node.callee.object, first, false)) {
      overwrite(context, node.arguments[0], quoteString("invoker", context.style))
    }
  })
}

/** Old subpaths in `vi.mock()`, dynamic imports, and `declare module`. */
function rewriteModuleStrings(context: FileContext) {
  walk(context.program, (node, ancestors) => {
    if (node.type !== "StringLiteral") return
    const parent = ancestors.at(-1)
    const imported = parent && importedCall(context, parent)
    const moduleSource = (parent?.type === "ImportExpression" && parent.source === node)
      || (parent?.type === "TSModuleDeclaration" && parent.id === node)
      || (parent?.type === "CallExpression" && parent.arguments[0] === node
        && (parent.callee.type === "Import" || (imported?.source === "vitest" && ["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"].includes(imported.name ?? ""))))
    const moved = movedSource(node.value)
    if (moved && !moduleSource) {
      // Static import and export sources are handled by rewriteImports().
      if (parent?.type !== "ImportDeclaration" && parent?.type !== "ExportNamedDeclaration" && parent?.type !== "ExportAllDeclaration") {
        followUp(context, node, `If this string is a module path, replace it with \`${moved}\`; the codemod kept the data literal unchanged.`)
      }
      return
    }
    if (moved) overwrite(context, node, quoteString(moved, context.style))
  })
}

function rewriteBlock(context: FileContext): boolean {
  const before = context.output.toString()
  const bindings = blockBindings(context.program)
  const { definitionLocals, hubAgentLocals, importsAgent } = rewriteImports(context, bindings)
  rewriteModuleStrings(context)
  rewriteProviderKeys(context, hubAgentLocals)
  if (importsAgent) {
    rewritePresetSelection(context, definitionLocals)
    rewriteActor(context, definitionLocals)
  }
  return context.output.toString() !== before
}

async function sourceFiles(cwd: string): Promise<string[]> {
  return (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of await sourceFiles(cwd)) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needles.test(source)) continue
    const output = new MagicString(source)
    let changed = false
    for (const block of scriptBlocks(file, source)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Update its Agent imports by hand.` })
        continue
      }
      const imports: FileContext["imports"] = new Map()
      for (const statement of program.program.body) {
        if (statement.type !== "ImportDeclaration") continue
        for (const specifier of statement.specifiers) imports.set(specifier.local, { source: statement.source.value, name: importedName(specifier) })
      }
      const context: FileContext = { block, file, followUps, output, program, imports, resolveBinding: bindingResolver(program), style: detectStyle(block.code, program) }
      // MagicString rejects two edits of the same range. One failed rewrite must not stop the other files.
      try {
        if (rewriteBlock(context)) changed = true
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not rewrite this file (${error instanceof Error ? error.message : String(error)}). Update its Agent imports by hand.` })
      }
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `moved the Agent imports and options of ${edits.length} file(s) to the new names` : "found no Agent import or option to change",
    edits,
    followUps,
    notes: edits.length ? ["`input.context.actor` and the `actor` field of Agent callbacks are gone. ViteHub reads only `invoker`, so an `actor` the codemod did not see no longer sets the caller."] : [],
    nextSteps: edits.length ? ["Run your typecheck. It reports the `actor` reads that the codemod could not rewrite."] : [],
  }
}

export const agentSurface: Codemod = {
  name: "agent-surface",
  description: "Rename the Agent APIs: invoker, loadAgent, agentWorkflow, extends, providers driver, and the process, invocations, and state entries",
  usage: "[dir]",
  detect: async ({ cwd }) => {
    const dependencies = await readDependencies(cwd)
    if (!dependencies.has("vite-hub") && !dependencies.has("@vite-hub/agent")) return undefined
    for (const file of await sourceFiles(cwd)) {
      const source = await readFile(join(cwd, file), "utf8")
      const legacyContext = /\b(?:actor|workflow)\b/.test(source) && /["'](?:vite-hub\/agent|@vite-hub\/agent)["']/.test(source)
      if (legacyContext || /AgentActor|AgentInvokerProfile|getAgentFromRegistry|agent\/(?:process-host|runtime\/process|invocations\/(?:d1|sqlite)|state\/sqlite)|\bpresets\s*:\s*\{/.test(source)) {
        return { reason: `${file} uses an Agent API that was renamed` }
      }
      if (/\b(?:state|scheduler|sandbox)\s*:\s*\{\s*provider\s*:/.test(source)) return { reason: `${file} selects an Agent provider with \`provider\`` }
    }
    return undefined
  },
  run: migrate,
}
