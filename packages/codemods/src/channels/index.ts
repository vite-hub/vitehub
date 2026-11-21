import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, isReference, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { CallExpression, Expression, File, Identifier, ImportDeclaration, ObjectExpression, ObjectProperty } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** Modules that exported `http()`. `http(options)` is now `channelAdapter("http", options)`. */
const httpModules = new Set(["vite-hub/agent/channels", "@vite-hub/agent/channels"])

/** Calls whose first argument names a module, such as `vi.mock("vite-hub/agent/channels")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /vite-hub\/agent\/channels|\bhttp\b|\b(?:webhook|stripe)\b|\bsecretToken\b/

/** Modules whose import marks a file with Agent webhook registrations, in `webhooks` of a Channel or a trigger. */
const agentModules = /^(?:@?vite-hub\/(?:agent|channels)(?:\/|$)|vite-hub\/agent\/)/

/** Modules that export `webhook()` and `stripe()`, whose `secret` and `signature` follow Webhooks now. */
const webhookModules = new Set(["vite-hub/channels", "@vite-hub/channels"])

/** Signature names before they followed `defineWebhook({ signature })`. */
const renamedSignatures = new Map([["github-sha256", "github"], ["stripe-sha256", "stripe"]])

const variableName = /^[A-Z_][A-Z0-9_]*$/i


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

function property(object: ObjectExpression, name: string): ObjectProperty | undefined {
  const found = object.properties.find(entry => entry.type === "ObjectProperty" && !entry.computed && keyName(entry.key) === name)
  return found?.type === "ObjectProperty" ? found : undefined
}

function unwrap(node: Node): Node {
  let current = node
  while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "TSNonNullExpression" || current.type === "ParenthesizedExpression") current = current.expression
  return current
}

/** `toleranceSeconds: 60` becomes `tolerance: "60s"`. Returns false when the value is not a number literal. */
function renameTolerance(context: FileContext, entry: ObjectProperty): boolean {
  const value = unwrap(entry.value)
  if (value.type !== "NumericLiteral") {
    followUp(context, entry, "`toleranceSeconds` is now `tolerance`, a duration such as `tolerance: \"5m\"`. Set it by hand.")
    return false
  }
  overwrite(context, entry, `tolerance: ${quoteString(`${value.value}s`, context.style)}`)
  return true
}

/** Rewrites a signature and returns whether it used the old syntax. */
function rewriteSignature(context: FileContext, entry: ObjectProperty): boolean {
  const value = unwrap(entry.value)
  if (value.type === "StringLiteral") {
    const renamed = renamedSignatures.get(value.value)
    if (renamed) overwrite(context, value, quoteString(renamed, context.style))
    return renamed !== undefined
  }
  if (value.type !== "ObjectExpression") return false
  const tolerance = property(value, "toleranceSeconds")
  if (tolerance) renameTolerance(context, tolerance)
  const preset = property(value, "preset")
  if (!preset) return tolerance !== undefined
  const name = unwrap(preset.value)
  if (name.type !== "StringLiteral") {
    followUp(context, preset, "`signature: { preset }` is now `signature: { type }`. Set it by hand.")
    return true
  }
  const type = name.value === "stripe-sha256" ? "stripe" : name.value
  overwrite(context, preset, `type: ${quoteString(type, context.style)}`)
  return true
}

/**
 * A string `secret` names a server variable now. Only wrap expressions known to return secret values.
 */
function rewriteSecret(context: FileContext, entry: ObjectProperty, ambiguousLiteral: boolean) {
  const value = unwrap(entry.value)
  if (isSecretResolverOrFlag(value)) return
  const name = processEnvName(value)
  if (name) {
    overwrite(context, value, quoteString(name, context.style))
    return
  }
  const literal = value.type === "StringLiteral" ? value.value : value.type === "TemplateLiteral" && !value.expressions.length ? value.quasis[0]?.value.cooked : undefined
  if (literal !== undefined && literal !== null && variableName.test(literal)) {
    if (ambiguousLiteral) followUp(context, entry, "Check that `secret` names a server variable. If it is a secret value, move it to a server variable and set `secret` to that variable's name.")
    return
  }
  if (literal !== undefined && literal !== null) {
    followUp(context, entry, "This secret is written in the code. Move it to a server variable and set `secret` to its name, such as `secret: \"PREFECT_WEBHOOK_SECRET\"`.")
    wrapSecret(context, entry)
    return
  }
  if (isServerEnvRead(value)) {
    wrapSecret(context, entry)
    return
  }
  followUp(context, entry, "Check what `secret` returns. Pass the name of the server variable or a function that returns the secret. Keep existing secret resolvers as they are.")
}

function isSecretResolverOrFlag(value: Node): boolean {
  return value.type === "BooleanLiteral" || value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression" || value.type === "ObjectExpression"
}

function isServerEnvRead(value: Node): boolean {
  if (value.type !== "MemberExpression" || value.computed) return false
  const object = unwrap(value.object)
  return isServerEnvRead(object) || (object.type === "CallExpression" && object.callee.type === "Identifier" && object.callee.name === "useServerEnv" && !object.arguments.length)
}

function wrapSecret({ block, output }: FileContext, entry: ObjectProperty) {
  output.prependLeft(block.offset + start(entry.value), "() => ")
}

/** The `process.env` variable that `node` reads, such as `X` in `process.env.X`. */
function processEnvName(node: Node): string | undefined {
  if (node.type !== "MemberExpression" || node.object.type !== "MemberExpression") return undefined
  const { object } = node
  if (object.object.type !== "Identifier" || object.object.name !== "process" || object.computed) return undefined
  if (object.property.type !== "Identifier" || object.property.name !== "env") return undefined
  const name = node.computed ? (node.property.type === "StringLiteral" ? node.property.value : undefined) : node.property.type === "Identifier" ? node.property.name : undefined
  return name && variableName.test(name) ? name : undefined
}

/**
 * An Agent webhook registration: `secretToken` becomes `secret`, and the signature takes the Webhooks name.
 * `secretToken: process.env.X` becomes `secret: "X"`. A literal stays, with a report line: it is a value, and a
 * `secret` string names a variable.
 */
function rewriteRegistration(context: FileContext, registration: ObjectExpression) {
  const signature = property(registration, "signature")
  if (signature) rewriteSignature(context, signature)
  const token = property(registration, "secretToken")
  if (!token) return
  const value = unwrap(token.value)
  const { style } = context
  const name = processEnvName(value)
  if (name) {
    overwrite(context, token, `secret: ${quoteString(name, style)}`)
    return
  }
  if (value.type === "StringLiteral" || value.type === "TemplateLiteral") {
    followUp(context, token, "`secretToken` is now `secret`, and a `secret` string names the server variable that holds the secret. Move this secret to a server variable, such as `GITHUB_WEBHOOK_SECRET`, and set `secret: \"GITHUB_WEBHOOK_SECRET\"`.")
    return
  }
  const envRead = isServerEnvRead(value)
  if (!envRead && !isSecretResolverOrFlag(value)) {
    followUp(context, token, "`secretToken` is now `secret`. Set `secret` to the name of the server variable that holds the secret, or to a function that returns it.")
    return
  }
  overwrite(context, token.key, "secret")
  if (envRead) wrapSecret(context, token)
}

/** Registrations under a `webhooks` key: one object, an array of them, or a map of them by provider, as in `chat()`. */
function webhookRegistrations(value: Node): ObjectExpression[] {
  const node = unwrap(value)
  if (node.type === "ArrayExpression") return node.elements.flatMap(element => element && element.type === "ObjectExpression" ? [element] : [])
  if (node.type !== "ObjectExpression") return []
  const keys = node.properties.flatMap(entry => entry.type === "ObjectProperty" && !entry.computed ? [keyName(entry.key)] : [])
  const registrationKeys = ["secretToken", "secret", "signature", "secretHeader", "path", "aliases", "provider", "id"]
  if (keys.some(key => key && registrationKeys.includes(key)) || !keys.length) return [node]
  return node.properties.flatMap(entry => entry.type === "ObjectProperty" && unwrap(entry.value).type === "ObjectExpression" ? [unwrap(entry.value) as ObjectExpression] : [])
}

/** Rewrites Agent webhook registrations in a file that imports ViteHub Agents or Channels. */
function rewriteAgentRegistrations(context: FileContext) {
  const { program } = context
  const imports = program.program.body.some(statement => statement.type === "ImportDeclaration" && agentModules.test(statement.source.value))
  if (!imports) return
  walk(program, (node) => {
    if (node.type !== "ObjectProperty" || node.computed || keyName(node.key) !== "webhooks") return
    for (const registration of webhookRegistrations(node.value)) rewriteRegistration(context, registration)
  })
}

/** Rewrites the options of `webhook()` and `stripe()` from `vite-hub/channels`. */
function rewriteWebhookOptions(context: FileContext) {
  const { program } = context
  const resolve = bindingResolver(program)
  const adapters = new Map<Identifier, "stripe" | "webhook">()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !webhookModules.has(statement.source.value) || statement.importKind === "type") continue
    for (const specifier of statement.specifiers) {
      const name = importedName(specifier)
      if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && (name === "stripe" || name === "webhook")) adapters.set(specifier.local, name)
    }
  }
  if (!adapters.size) return
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
    const binding = resolve(node.callee)
    const adapter = binding && adapters.get(binding)
    const options = adapter && node.arguments[0] && unwrap(node.arguments[0] as Expression)
    if (options?.type !== "ObjectExpression") return
    const signature = property(options, "signature")
    const legacySignature = signature && rewriteSignature(context, signature)
    const secret = property(options, "secret")
    if (secret) rewriteSecret(context, secret, adapter === "stripe" || legacySignature === true)
    const tolerance = adapter === "stripe" ? property(options, "toleranceSeconds") : undefined
    if (tolerance) renameTolerance(context, tolerance)
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
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). ${manualHttp} Migrate webhook secrets and signatures by hand.` })
        continue
      }
      const before = output.toString()
      const context: FileContext = { block, file, followUps, output, program, style: detectStyle(block.code, program) }
      replaceHttp(context)
      rewriteWebhookOptions(context)
      rewriteAgentRegistrations(context)
      changed = output.toString() !== before || changed
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `replaced http() and moved webhook options in ${edits.length} file(s)` : "no http() call or webhook option changed",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const channels: Codemod = {
  name: "channels",
  description: "Replace the Agent `http()` adapter with `channelAdapter(\"http\")`, and move `webhook()`, `stripe()`, and Agent webhook registrations to `secret` names and Webhooks signature names",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} calls the Agent \`http()\` adapter or sets an old webhook option` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs a manual Agent Channel migration` } : undefined
  },
  run: migrate,
}
