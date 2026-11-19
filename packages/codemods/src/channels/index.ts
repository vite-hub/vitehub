import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, keyName, isReference, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { Expression, File, Identifier, ImportDeclaration, ObjectExpression, ObjectProperty, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** `vite-hub/agent/channels` joined `vite-hub/channels`. The owner path `@vite-hub/agent/channels` stays. */
const movedPath = "vite-hub/agent/channels"
const channelsPath = "vite-hub/channels"

/** Modules that exported `http()`. `http(options)` is now `channelAdapter("http", options)`. */
const httpModules = new Set([movedPath, channelsPath, "@vite-hub/agent/channels"])

/** Calls whose first argument names a module, such as `vi.mock("vite-hub/agent/channels")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /vite-hub\/agent\/channels|\bhttp\b|\b(?:webhook|stripe)\b|\bsecretToken\b/

/** Modules whose import marks a file with Agent webhook registrations, in `webhooks` of a Channel or a trigger. */
const agentModules = /^(?:@?vite-hub\/(?:agent|channels)(?:\/|$)|vite-hub\/agent\/)/

/** Modules that export `webhook()` and `stripe()`, whose `secret` and `signature` follow Webhooks now. */
const webhookModules = new Set([channelsPath, "@vite-hub/channels"])

/** Signature names before they followed `defineWebhook({ signature })`. */
const renamedSignatures = new Map([["github-sha256", "github"], ["stripe-sha256", "stripe"]])

const variableName = /^[A-Z_][A-Z0-9_]*$/i

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
  /** The new text of an import specifier that `replaceHttp()` changed. `null` when it removed it. */
  specifiers: Map<Node, string | null>
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

function isNamedImport(statement: ImportDeclaration): boolean {
  return statement.specifiers.length > 0 && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")
}

function replaceSource(context: FileContext, source: StringLiteral) {
  overwrite(context, source, quoteString(channelsPath, context.style))
}

/**
 * Moves imports and re-exports of `vite-hub/agent/channels` to `vite-hub/channels`. A named import joins an earlier
 * named import of `vite-hub/channels` of the same kind, so a file ends with one import.
 */
function moveImports(context: FileContext) {
  const { block, output, program } = context
  const targets = new Map<string, ImportDeclaration>()
  const key = (statement: ImportDeclaration) => `${statement.importKind ?? "value"}`
  for (const statement of program.program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === channelsPath && isNamedImport(statement) && !targets.has(key(statement))) {
      targets.set(key(statement), statement)
    }
  }
  for (const statement of program.program.body) {
    if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source?.value === movedPath) {
      replaceSource(context, statement.source)
      continue
    }
    if (statement.type !== "ImportDeclaration" || statement.source.value !== movedPath) continue
    const target = isNamedImport(statement) ? targets.get(key(statement)) : undefined
    if (!target) {
      replaceSource(context, statement.source)
      if (isNamedImport(statement)) targets.set(key(statement), statement)
      continue
    }
    // `replaceHttp()` ran first, so take the names with its edits.
    const names = statement.specifiers.flatMap((specifier) => {
      const text = context.specifiers.get(specifier)
      return text === null ? [] : [text ?? block.code.slice(start(specifier), end(specifier))]
    }).join(", ")
    if (names) output.appendLeft(block.offset + end(target.specifiers.at(-1)!), `, ${names}`)
    const [from, to] = listItemRemoval(block.code, statement)
    output.remove(block.offset + from, block.offset + to)
  }
  walk(program, (node) => {
    if (node.type === "ImportExpression" && node.source.type === "StringLiteral" && node.source.value === movedPath) {
      replaceSource(context, node.source)
      return
    }
    if (node.type !== "CallExpression") return
    const [first] = node.arguments
    if (first?.type !== "StringLiteral" || first.value !== movedPath) return
    const callee = node.callee
    const name = callee.type === "Import" ? "import" : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : undefined
    if (name === "import" || (name && moduleCalls.has(name))) replaceSource(context, first)
  })
}

/** `http(options)` becomes `channelAdapter("http", options)`, the same Channel with the generic adapter. */
function replaceHttp(context: FileContext) {
  const { block, output, program, style } = context
  const imports = program.program.body.filter((statement): statement is ImportDeclaration =>
    statement.type === "ImportDeclaration" && httpModules.has(statement.source.value) && statement.importKind !== "type")
  const valueSpecifiers = imports.flatMap(statement => statement.specifiers.flatMap(specifier =>
    specifier.type === "ImportSpecifier" && specifier.importKind !== "type" ? [{ statement, specifier }] : []))
  const http = valueSpecifiers.filter(({ specifier }) => importedName(specifier) === "http")
  if (!http.length) return
  let adapterName = valueSpecifiers.find(({ specifier }) => importedName(specifier) === "channelAdapter")?.specifier.local.name
  const resolve = bindingResolver(program)
  const references = new Map<Identifier, Identifier[]>(http.map(({ specifier }) => [specifier.local, []]))
  const parents = new Map<Identifier, Node | undefined>()
  const names = new Set<string>()
  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier") return
    names.add(node.name)
    if (!isReference(node, ancestors.at(-1))) return
    const binding = resolve(node)
    const list = binding && references.get(binding)
    if (!list) return
    list.push(node)
    parents.set(node, ancestors.at(-1))
  })
  const kind = quoteString("http", style)
  for (const { statement, specifier } of http) {
    const calls = references.get(specifier.local)!
    const other = calls.find((node) => {
      const parent = parents.get(node)
      return parent?.type !== "CallExpression" || parent.callee !== node
    })
    if (other) {
      followUp(context, other, "`http()` was removed. Import `channelAdapter` from `vite-hub/channels`, and replace this reference with `(options) => channelAdapter(\"http\", options)`.")
      continue
    }
    let callee: string
    if (adapterName) {
      // The file already imports `channelAdapter`: drop `http` and call the existing name.
      const [from, to] = listItemRemoval(block.code, statement.specifiers.length === 1 ? statement : specifier)
      output.remove(block.offset + from, block.offset + to)
      context.specifiers.set(specifier, null)
      callee = adapterName
    }
    else if (specifier.local.name !== "http") {
      overwrite(context, specifier.imported, "channelAdapter")
      context.specifiers.set(specifier, `channelAdapter as ${specifier.local.name}`)
      callee = specifier.local.name
    }
    else if (names.has("channelAdapter")) {
      followUp(context, specifier, "`http()` was removed. Import `channelAdapter` from `vite-hub/channels`, and replace `http(options)` with `channelAdapter(\"http\", options)`. This file already has a `channelAdapter` name, so the codemod left it.")
      continue
    }
    else {
      overwrite(context, specifier, "channelAdapter")
      context.specifiers.set(specifier, "channelAdapter")
      callee = adapterName = "channelAdapter"
    }
    for (const node of calls) {
      const call = parents.get(node)
      if (call?.type !== "CallExpression") continue
      if (callee !== node.name) overwrite(context, node, callee)
      const open = block.code.indexOf("(", end(call.typeParameters ?? node))
      output.appendLeft(block.offset + open + 1, call.arguments.length ? `${kind}, ` : kind)
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

/** The new `signature` value: Webhooks names, `{ type }` in place of `{ preset }`, and `tolerance` in place of `toleranceSeconds`. */
function rewriteSignature(context: FileContext, entry: ObjectProperty) {
  const value = unwrap(entry.value)
  if (value.type === "StringLiteral") {
    const renamed = renamedSignatures.get(value.value)
    if (renamed) overwrite(context, value, quoteString(renamed, context.style))
    return
  }
  if (value.type !== "ObjectExpression") return
  const preset = property(value, "preset")
  if (!preset) return
  const name = unwrap(preset.value)
  if (name.type !== "StringLiteral") {
    followUp(context, preset, "`signature: { preset }` is now `signature: { type }`. Set it by hand.")
    return
  }
  const type = name.value === "stripe-sha256" ? "stripe" : name.value
  overwrite(context, preset, `type: ${quoteString(type, context.style)}`)
  const tolerance = property(value, "toleranceSeconds")
  if (tolerance) renameTolerance(context, tolerance)
}

/**
 * A string `secret` names a server variable now. `process.env.NAME` becomes `"NAME"`. A value that the code computes,
 * such as `useServerEnv().x`, or a literal that cannot be a name, moves into a function, so it keeps working. Each
 * rewrite gives the new form, so a second run changes nothing.
 */
function rewriteSecret(context: FileContext, entry: ObjectProperty) {
  const value = unwrap(entry.value)
  const { block, output } = context
  if (value.type === "BooleanLiteral" || value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") return
  if (value.type === "MemberExpression" && value.object.type === "MemberExpression"
    && value.object.object.type === "Identifier" && value.object.object.name === "process"
    && value.object.property.type === "Identifier" && value.object.property.name === "env" && !value.object.computed) {
    const name = value.computed ? (value.property.type === "StringLiteral" ? value.property.value : undefined) : value.property.type === "Identifier" ? value.property.name : undefined
    if (name && variableName.test(name)) {
      overwrite(context, value, quoteString(name, context.style))
      return
    }
  }
  // A name is the new form. Code that still passes a value, such as "token", fails closed: the variable is unset.
  if (value.type === "StringLiteral" && variableName.test(value.value)) return
  if (entry.shorthand || value.type === "Identifier") {
    followUp(context, entry, "A string `secret` is now the name of the server variable that holds the secret. Pass the name, such as `secret: \"PREFECT_WEBHOOK_SECRET\"`, or a function that returns the secret.")
    return
  }
  output.prependLeft(block.offset + start(value), "() => ")
  if (value.type === "StringLiteral" || value.type === "TemplateLiteral") {
    followUp(context, entry, "This secret is written in the code. Move it to a server variable and set `secret` to its name, such as `secret: \"PREFECT_WEBHOOK_SECRET\"`.")
  }
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
  const { block, output, style } = context
  const name = processEnvName(value)
  if (name) {
    overwrite(context, token, `secret: ${quoteString(name, style)}`)
    return
  }
  if (value.type === "StringLiteral" || value.type === "TemplateLiteral") {
    followUp(context, token, "`secretToken` is now `secret`, and a `secret` string names the server variable that holds the secret. Move this secret to a server variable, such as `GITHUB_WEBHOOK_SECRET`, and set `secret: \"GITHUB_WEBHOOK_SECRET\"`.")
    return
  }
  if (token.shorthand || value.type === "Identifier") {
    followUp(context, token, "`secretToken` is now `secret`. Set `secret` to the name of the server variable that holds the secret, or to a function that returns it.")
    return
  }
  overwrite(context, token.key, "secret")
  // A value that the code computes, such as `useServerEnv().github.webhookSecret`, moves into a function.
  const computed = value.type !== "BooleanLiteral" && value.type !== "ArrowFunctionExpression" && value.type !== "FunctionExpression" && value.type !== "ObjectExpression"
  if (computed) output.prependLeft(block.offset + start(value), "() => ")
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
    if (signature) rewriteSignature(context, signature)
    const secret = property(options, "secret")
    if (secret) rewriteSecret(context, secret)
    const tolerance = adapter === "stripe" ? property(options, "toleranceSeconds") : undefined
    if (tolerance) renameTolerance(context, tolerance)
  })
}

function rewriteBlock(context: FileContext): boolean {
  const before = context.output.toString()
  replaceHttp(context)
  moveImports(context)
  rewriteWebhookOptions(context)
  rewriteAgentRegistrations(context)
  return context.output.toString() !== before
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
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Import Channel adapters from \`vite-hub/channels\`, and replace \`http(options)\` with \`channelAdapter("http", options)\` by hand, and set webhook secrets to server variable names.` })
        continue
      }
      const context: FileContext = { block, file, followUps, output, program, specifiers: new Map(), style: detectStyle(block.code, program) }
      changed = rewriteBlock(context) || changed
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }
  return {
    summary: edits.length ? `moved Channel imports and webhook options in ${edits.length} file(s)` : "found no vite-hub/agent/channels import, http() Channel, or webhook option to move",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const channels: Codemod = {
  name: "channels",
  description: "Import Channel adapters from `vite-hub/channels`, replace `http()` with `channelAdapter(\"http\")`, and move `webhook()`, `stripe()`, and Agent webhook registrations to `secret` names and Webhooks signature names",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} imports \`vite-hub/agent/channels\`, calls \`http()\`, or sets an old webhook option` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs the \`vite-hub/channels\` change` } : undefined
  },
  run: migrate,
}
