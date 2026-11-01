import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { detectStyle, end, isReference, keyName, line, parseProgram, quoteString, start, walk } from "../ast.ts"
import { pathLabel } from "./fields.ts"

import type { CallExpression, File, ObjectPattern, ObjectProperty } from "@babel/types"
import type { CodeStyle, Node } from "../ast.ts"
import type { FileEdit, FollowUp } from "../types.ts"
import type { EnvField } from "./fields.ts"

const serverImport = "#vitehub/env/server"
const publicImport = "#vitehub/env/public"

export interface CallSiteInput {
  cwd: string
  fields: readonly EnvField[]
  /** `runtimeConfig` labels that stay, such as `public.tags`. */
  unmigrated: readonly string[]
}

export interface SecretRead {
  field: EnvField
  file: string
  line: number
}

export interface CallSiteResult {
  edits: FileEdit[]
  followUps: FollowUp[]
  secretReads: SecretRead[]
  /** Files that still call `useSafeRuntimeConfig()`. */
  remaining: string[]
}

type Context = "app" | "server" | "shared"

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

interface FileState {
  file: string
  context: Context
  output: MagicString
  followUps: FollowUp[]
  secretReads: SecretRead[]
  template?: string
  changed: boolean
  remainingCalls: number
}

type Target =
  | { kind: "field", field: EnvField, consumed: number }
  | { kind: "server-group" }
  | { kind: "public-root" }
  | { kind: "kept", label: string }
  | { kind: "unsupported", message: string }

interface Read {
  /** Static property names after the config object. */
  segments: string[]
  /** The member expression for each segment. */
  members: Node[]
  line: number
}

type Access = { kind: "read", read: Read } | { kind: "other", line: number, reason: string }

function classify(file: string): Context {
  const segments = file.split("/")
  if (segments.includes("server")) return "server"
  if (segments.includes("shared")) return "shared"
  return "app"
}

function scriptBlocks(file: string, source: string): { blocks: Block[], template?: string } {
  if (!file.endsWith(".vue")) {
    return {
      blocks: [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }],
    }
  }
  const { descriptor } = parseSfc(source, { filename: file })
  const blocks = [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
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
  return { blocks, template: descriptor.template?.content }
}

function memberName(node: Node): string | undefined {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return undefined
  return keyName(node.property, node.computed)
}

/** How code uses an expression that holds the config object. */
function accessOf(node: Node, ancestors: readonly Node[], lineOffset: number): Access {
  const segments: string[] = []
  const members: Node[] = []
  let current = node
  let index = ancestors.length - 1
  while (index >= 0) {
    const parent = ancestors[index]
    if (!parent || (parent.type !== "MemberExpression" && parent.type !== "OptionalMemberExpression") || parent.object !== current) break
    const name = memberName(parent)
    if (!name) return { kind: "other", line: line(parent) + lineOffset, reason: "reads a computed property" }
    segments.push(name)
    members.push(parent)
    current = parent
    index--
  }
  const top = ancestors[index]
  const nodeLine = line(node) + lineOffset
  if (!segments.length) return { kind: "other", line: nodeLine, reason: "passes the config object on" }
  if (top && ((top.type === "AssignmentExpression" && top.left === current) || top.type === "UpdateExpression" || (top.type === "UnaryExpression" && top.operator === "delete"))) {
    return { kind: "other", line: nodeLine, reason: "writes to the config object" }
  }
  return { kind: "read", read: { segments, members, line: nodeLine } }
}

class Resolver {
  private readonly byLabel = new Map<string, EnvField>()

  constructor(private readonly fields: readonly EnvField[], private readonly unmigrated: readonly string[]) {
    for (const field of fields) this.byLabel.set(pathLabel(field), field)
  }

  /** Server fields whose path starts with `segments`. */
  fieldsUnder(segments: readonly string[]): EnvField[] {
    return this.fields.filter(field => field.section === "server" && segments.every((segment, index) => field.configPath[index] === segment))
  }

  resolve(segments: readonly string[]): Target {
    const publicRead = segments[0] === "public"
    const rest = publicRead ? segments.slice(1) : segments
    const prefix = publicRead ? ["public"] : []
    for (let length = 1; length <= rest.length; length++) {
      const label = [...prefix, ...rest.slice(0, length)].join(".")
      const field = this.byLabel.get(label)
      if (field) return { kind: "field", field, consumed: length + prefix.length }
      if (this.unmigrated.includes(label)) return { kind: "kept", label }
    }
    const label = [...prefix, ...rest].join(".")
    const nested = this.fields.filter(field => field.section === (publicRead ? "public" : "server")
      && rest.every((segment, position) => field.configPath[position] === segment) && field.configPath.length > rest.length)
    const keptBelow = this.unmigrated.some(entry => entry.startsWith(`${label}.`) || (publicRead && !rest.length && entry.startsWith("public")))
    if (publicRead && !keptBelow && (rest.length ? nested.length : true)) {
      const flat = this.fields.filter(field => field.section === "public").every(field => field.configPath.length === 1)
      if (!rest.length && flat) return { kind: "public-root" }
      return { kind: "unsupported", message: `Reads the ${label} object. Public Env is flat, so nested public groups do not exist. Read each field from usePublicEnv(), for example usePublicEnv().${this.fields.find(field => field.section === "public" && field.configPath.length > 1)?.envPath[0] ?? "name"}.` }
    }
    if (!publicRead && rest.length && nested.length && !keptBelow) return { kind: "server-group" }
    return { kind: "kept", label }
  }
}

function sameImport(program: File, source: string, name: string): boolean {
  return program.program.body.some(statement => statement.type === "ImportDeclaration" && statement.source.value === source
    && statement.specifiers.some(specifier => specifier.local.name === name))
}

function bindingScope(ancestors: readonly Node[]): Node | undefined {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const node = ancestors[index]
    if (!node) continue
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
      || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "Program") {
      return node
    }
  }
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface Rewrite {
  edits: Array<{ from: number, to: number, text: string }>
  needsServer: boolean
  needsPublic: boolean
}

class BlockRewriter {
  readonly program: File
  private readonly style: Pick<CodeStyle, "quote" | "semicolons">

  constructor(
    private readonly state: FileState,
    private readonly block: Block,
    private readonly resolver: Resolver,
  ) {
    this.program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
    this.style = detectStyle(block.code, this.program)
  }

  private follow(lineNumber: number, message: string): void {
    this.state.followUps.push({ file: this.state.file, line: lineNumber, message })
  }

  private lineOf(node: Node): number {
    return line(node) + this.block.lineOffset
  }

  run(): void {
    const safeCalls: Array<{ call: CallExpression, ancestors: Node[] }> = []
    const runtimeCalls: Array<{ call: CallExpression, ancestors: Node[] }> = []
    walk(this.program, (node, ancestors) => {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
      if (node.callee.name === "useSafeRuntimeConfig") safeCalls.push({ call: node, ancestors: [...ancestors] })
      if (node.callee.name === "useRuntimeConfig") runtimeCalls.push({ call: node, ancestors: [...ancestors] })
    })
    let needsServer = false
    let needsPublic = false
    for (const { call, ancestors } of safeCalls) {
      const rewrite = this.planCall(call, ancestors)
      if (!rewrite) {
        this.state.remainingCalls++
        continue
      }
      for (const edit of rewrite.edits) this.state.output.overwrite(this.block.offset + edit.from, this.block.offset + edit.to, edit.text)
      needsServer ||= rewrite.needsServer
      needsPublic ||= rewrite.needsPublic
      this.state.changed = true
    }
    for (const { call, ancestors } of runtimeCalls) this.checkRuntimeConfigCall(call, ancestors)
    this.updateImports(needsServer, needsPublic)
  }

  private updateImports(needsServer: boolean, needsPublic: boolean): void {
    const imports = this.program.program.body.filter(statement => statement.type === "ImportDeclaration")
    const lines: string[] = []
    const semicolon = this.style.semicolons ? ";" : ""
    if (needsServer && !sameImport(this.program, serverImport, "useServerEnv")) {
      lines.push(`import { useServerEnv } from ${quoteString(serverImport, this.style)}${semicolon}`)
    }
    if (needsPublic && !sameImport(this.program, publicImport, "usePublicEnv")) {
      lines.push(`import { usePublicEnv } from ${quoteString(publicImport, this.style)}${semicolon}`)
    }
    const removed = new Set<Node>()
    let replacedImport = false
    if (!this.state.remainingCalls) {
      for (const statement of imports) {
        const kept = statement.specifiers.filter(specifier => specifier.local.name !== "useSafeRuntimeConfig")
        if (kept.length === statement.specifiers.length) continue
        const from = this.block.offset + start(statement)
        const to = this.block.offset + end(statement)
        this.state.changed = true
        if (kept.length) {
          const names = kept.map(specifier => this.block.code.slice(start(specifier), end(specifier)))
          this.state.output.overwrite(from, to, `import { ${names.join(", ")} } from ${this.block.code.slice(start(statement.source), end(statement.source))}${semicolon}`)
          continue
        }
        removed.add(statement)
        if (lines.length && !replacedImport) {
          // Put the new imports where the removed import was.
          this.state.output.overwrite(from, to, lines.join("\n"))
          replacedImport = true
        }
        else {
          this.state.output.remove(from, this.block.code[end(statement)] === "\n" ? to + 1 : to)
        }
      }
    }
    if (!lines.length || replacedImport) return
    const last = imports.filter(statement => !removed.has(statement)).at(-1)
    if (last) this.state.output.appendLeft(this.block.offset + end(last), `\n${lines.join("\n")}`)
    else {
      const leading = /^\s*/.exec(this.block.code)?.[0] ?? ""
      this.state.output.appendLeft(this.block.offset + leading.length, `${lines.join("\n")}\n\n`)
    }
    this.state.changed = true
  }

  /** Plans one `useSafeRuntimeConfig()` call, or reports a follow-up and returns `undefined`. */
  private planCall(call: CallExpression, ancestors: readonly Node[]): Rewrite | undefined {
    const context = this.state.context
    const callLine = this.lineOf(call)
    if (context === "shared") {
      this.follow(callLine, "useSafeRuntimeConfig() in shared code runs on the server and in the app. Use useServerEnv() from #vitehub/env/server in server code and usePublicEnv() from #vitehub/env/public elsewhere.")
      return undefined
    }
    const parent = ancestors.at(-1)
    if (parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.object === call) {
      const access = accessOf(call, ancestors, this.block.lineOffset)
      return this.planReads(call, [access], { kind: "direct" })
    }
    if (parent?.type === "VariableDeclarator" && parent.init === call) {
      if (parent.id.type === "Identifier") return this.planBinding(call, parent.id.name, ancestors)
      if (parent.id.type === "ObjectPattern") return this.planPattern(call, parent.id, parent)
    }
    if (parent?.type === "AwaitExpression") {
      this.follow(callLine, "useSafeRuntimeConfig() is awaited. Rewrite it by hand: useServerEnv() and usePublicEnv() are synchronous.")
      return undefined
    }
    this.follow(callLine, "useSafeRuntimeConfig() passes the config object on. Rewrite it by hand with useServerEnv() or usePublicEnv().")
    return undefined
  }

  /** Records the secret fields that a server read reaches, including the secrets in a group it reads whole. */
  private recordSecretReads(target: Target, segments: readonly string[], lineNumber: number): void {
    const fields = target.kind === "field"
      ? [target.field]
      : target.kind === "server-group"
        ? this.resolver.fieldsUnder(segments)
        : []
    for (const field of fields) {
      if (field.secret) this.state.secretReads.push({ field, file: this.state.file, line: lineNumber })
    }
  }

  private calleeEdit(call: CallExpression, name: string): { from: number, to: number, text: string } {
    return { from: start(call.callee), to: end(call.callee), text: name }
  }

  private planReads(call: CallExpression, accesses: readonly Access[], binding: { kind: "direct" } | { kind: "identifier", name: string }): Rewrite | undefined {
    const callLine = this.lineOf(call)
    const reads: Array<{ read: Read, target: Target }> = []
    for (const access of accesses) {
      if (access.kind === "other") {
        this.follow(access.line, `useSafeRuntimeConfig() result ${access.reason}. Rewrite it by hand with useServerEnv() or usePublicEnv().`)
        return undefined
      }
      const target = this.resolver.resolve(access.read.segments)
      if (target.kind === "kept") {
        this.follow(access.read.line, `Reads ${target.label}, which stays in runtimeConfig. Read it with useRuntimeConfig() and rewrite the rest of this useSafeRuntimeConfig() call by hand.`)
        return undefined
      }
      if (target.kind === "unsupported") {
        this.follow(access.read.line, `${target.message} Then rewrite this useSafeRuntimeConfig() call by hand.`)
        return undefined
      }
      reads.push({ read: access.read, target })
    }
    const isPublic = (target: Target) => target.kind === "public-root" || (target.kind === "field" && target.field.section === "public")
    const serverReads = reads.filter(entry => !isPublic(entry.target))
    const publicReads = reads.filter(entry => isPublic(entry.target))
    if (this.state.context === "app" && serverReads.length) {
      this.follow(serverReads[0]?.read.line ?? callLine, `App code reads the private key ${serverReads[0]?.read.segments.join(".")}. Server Env is for server code only. Move the read to a server route.`)
      return undefined
    }
    if (!reads.length) {
      this.follow(callLine, "useSafeRuntimeConfig() result is not read. Remove it or rewrite it by hand.")
      return undefined
    }
    for (const entry of serverReads) this.recordSecretReads(entry.target, entry.read.segments, entry.read.line)
    const edits: Rewrite["edits"] = []
    const publicOnly = !serverReads.length
    const publicBase = publicOnly && binding.kind === "identifier" ? binding.name : "usePublicEnv()"
    for (const entry of publicReads) {
      const { read, target } = entry
      const last = read.members[target.kind === "field" ? target.consumed - 1 : 0]
      if (!last) continue
      const text = target.kind === "field" ? `${publicBase}.${target.field.envPath[0]}` : publicBase
      edits.push({ from: this.objectStart(read), to: end(last), text })
    }
    if (binding.kind === "direct") {
      if (publicOnly) return { edits, needsServer: false, needsPublic: true }
      return { edits: [this.calleeEdit(call, "useServerEnv")], needsServer: true, needsPublic: false }
    }
    if (publicOnly) {
      edits.push({ from: start(call), to: end(call), text: "usePublicEnv()" })
      return { edits, needsServer: false, needsPublic: true }
    }
    edits.push(this.calleeEdit(call, "useServerEnv"))
    return { edits, needsServer: true, needsPublic: publicReads.length > 0 }
  }

  /** Start of the expression that holds the config object in a read such as `config.public.x`. */
  private objectStart(read: Read): number {
    const first = read.members[0]
    if (!first || (first.type !== "MemberExpression" && first.type !== "OptionalMemberExpression")) throw new TypeError("Expected a member read")
    return start(first.object)
  }

  private planBinding(call: CallExpression, name: string, ancestors: readonly Node[]): Rewrite | undefined {
    const scope = bindingScope(ancestors)
    const callLine = this.lineOf(call)
    if (!scope) return undefined
    if (this.state.template !== undefined && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(this.state.template)) {
      this.follow(callLine, `The template reads ${name}. Rewrite the template and this call by hand with usePublicEnv().`)
      return undefined
    }
    const declarator = ancestors.at(-1)
    const accesses: Access[] = []
    let shadowed = false
    walk(scope, (node, nodeAncestors) => {
      if (node.type !== "Identifier" || node.name !== name) return
      const parent = nodeAncestors.at(-1)
      if (parent === declarator && parent?.type === "VariableDeclarator" && parent.id === node) return
      if (parent?.type === "VariableDeclarator" && parent.id === node) shadowed = true
      if (parent && (parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression")
        && parent.params.some(param => param === node)) shadowed = true
      if (!isReference(node, parent)) return
      accesses.push(accessOf(node, nodeAncestors, this.block.lineOffset))
    })
    if (shadowed) {
      this.follow(callLine, `Another binding named ${name} shadows the config. Rewrite this call by hand.`)
      return undefined
    }
    return this.planReads(call, accesses, { kind: "identifier", name })
  }

  private planPattern(call: CallExpression, pattern: ObjectPattern, declarator: Node): Rewrite | undefined {
    const callLine = this.lineOf(call)
    const code = this.block.code
    if (pattern.typeAnnotation) {
      this.follow(callLine, "The destructured config has a type annotation. Rewrite it by hand.")
      return undefined
    }
    const serverProperties: ObjectProperty[] = []
    let publicProperty: ObjectProperty | undefined
    for (const property of pattern.properties) {
      const key = property.type === "ObjectProperty" ? keyName(property.key, property.computed) : undefined
      if (property.type !== "ObjectProperty" || !key) {
        this.follow(this.lineOf(property), "The destructuring pattern uses a rest element or a computed key. Rewrite it by hand.")
        return undefined
      }
      if (key === "public") {
        if (property.value.type !== "ObjectPattern" || property.value.properties.some(entry => entry.type !== "ObjectProperty"
          || !keyName(entry.key, entry.computed) || (entry.value.type !== "Identifier" && entry.value.type !== "AssignmentPattern"))) {
          this.follow(this.lineOf(property), "The public part of the pattern is not a flat list of keys. Rewrite it by hand with usePublicEnv().")
          return undefined
        }
        for (const entry of property.value.properties) {
          const entryKey = entry.type === "ObjectProperty" ? keyName(entry.key, entry.computed) : undefined
          const target = entryKey ? this.resolver.resolve(["public", entryKey]) : undefined
          if (target?.kind !== "field" || target.field.configPath.length !== 1) {
            this.follow(this.lineOf(entry), `public.${entryKey ?? "?"} ${target?.kind === "kept" ? "stays in runtimeConfig" : "is not a flat Public Env field"}. Rewrite this pattern by hand.`)
            return undefined
          }
        }
        publicProperty = property
        continue
      }
      const target = this.resolver.resolve([key])
      if (target.kind === "unsupported") {
        this.follow(this.lineOf(property), `${target.message} Rewrite this pattern by hand.`)
        return undefined
      }
      if (target.kind === "kept") {
        this.follow(this.lineOf(property), `Reads ${target.label}, which stays in runtimeConfig. Read it with useRuntimeConfig() and rewrite this pattern by hand.`)
        return undefined
      }
      this.recordSecretReads(target, [key], this.lineOf(property))
      serverProperties.push(property)
    }
    const context = this.state.context
    if (context === "app" && serverProperties.length) {
      this.follow(callLine, "App code destructures private keys. Server Env is for server code only. Move the read to a server route.")
      return undefined
    }
    if (!publicProperty) return { edits: [this.calleeEdit(call, "useServerEnv")], needsServer: true, needsPublic: false }
    const publicPattern = code.slice(start(publicProperty.value), end(publicProperty.value))
    if (!serverProperties.length) {
      return {
        edits: [
          { from: start(pattern), to: end(pattern), text: publicPattern },
          { from: start(call), to: end(call), text: "usePublicEnv()" },
        ],
        needsServer: false,
        needsPublic: true,
      }
    }
    const serverPattern = `{ ${serverProperties.map(property => code.slice(start(property), end(property))).join(", ")} }`
    const callText = `useServerEnv${code.slice(end(call.callee), end(call))}`
    return {
      edits: [{ from: start(declarator), to: end(declarator), text: `${serverPattern} = ${callText}, ${publicPattern} = usePublicEnv()` }],
      needsServer: true,
      needsPublic: true,
    }
  }

  private checkRuntimeConfigCall(call: CallExpression, ancestors: readonly Node[]): void {
    const parent = ancestors.at(-1)
    const accesses: Access[] = []
    if (parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.object === call) {
      accesses.push(accessOf(call, ancestors, this.block.lineOffset))
    }
    else if (parent?.type === "VariableDeclarator" && parent.init === call && parent.id.type === "Identifier") {
      const name = parent.id.name
      const scope = bindingScope(ancestors)
      if (scope) {
        walk(scope, (node, nodeAncestors) => {
          if (node.type !== "Identifier" || node.name !== name || node === parent.id || !isReference(node, nodeAncestors.at(-1))) return
          accesses.push(accessOf(node, nodeAncestors, this.block.lineOffset))
        })
      }
    }
    else if (parent?.type === "VariableDeclarator" && parent.init === call && parent.id.type === "ObjectPattern") {
      for (const property of parent.id.properties) {
        const key = property.type === "ObjectProperty" ? keyName(property.key, property.computed) : undefined
        if (property.type === "ObjectProperty" && key === "public" && property.value.type === "ObjectPattern") {
          for (const entry of property.value.properties) {
            const entryKey = entry.type === "ObjectProperty" ? keyName(entry.key, entry.computed) : undefined
            if (entryKey) this.reportRuntimeRead(["public", entryKey], this.lineOf(entry))
          }
        }
        else if (key) {
          this.reportRuntimeRead([key], this.lineOf(property))
        }
      }
      return
    }
    for (const access of accesses) {
      if (access.kind === "read") this.reportRuntimeRead(access.read.segments, access.read.line)
    }
  }

  private reportRuntimeRead(segments: readonly string[], lineNumber: number): void {
    const target = this.resolver.resolve(segments)
    if (target.kind === "kept") return
    if (target.kind === "unsupported") {
      this.follow(lineNumber, `useRuntimeConfig() reads ${segments.join(".")}, which moved to Env. ${target.message}`)
      return
    }
    const label = target.kind === "field" ? pathLabel(target.field) : segments.join(".")
    const replacement = target.kind === "field" && target.field.section === "server" || target.kind === "server-group"
      ? "useServerEnv() from #vitehub/env/server"
      : "usePublicEnv() from #vitehub/env/public"
    this.follow(lineNumber, `useRuntimeConfig() reads ${label}, which moved to Env and is no longer in runtimeConfig. Read it with ${replacement}.`)
  }
}

function templateConfigReads(state: FileState, template: string, resolver: Resolver): void {
  for (const match of template.matchAll(/\$config\.((?:[A-Za-z_$][\w$]*\.?)+)/g)) {
    const segments = (match[1] ?? "").split(".").filter(Boolean)
    const target = resolver.resolve(segments)
    if (target.kind === "kept") continue
    state.followUps.push({ file: state.file, message: `The template reads $config.${segments.join(".")}, which moved to Env. Read it with usePublicEnv() in the script.` })
  }
}

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**", "**/*.d.ts", "**/nuxt.config.*", "**/eslint.config.*"]

/** Rewrites `useSafeRuntimeConfig()` calls and reports reads that it cannot rewrite safely. */
export async function rewriteCallSites(input: CallSiteInput): Promise<CallSiteResult> {
  const resolver = new Resolver(input.fields, input.unmigrated)
  const files = (await glob(sourcePatterns, { cwd: input.cwd, ignore: ignoredPatterns, dot: false })).sort()
  const result: CallSiteResult = { edits: [], followUps: [], secretReads: [], remaining: [] }
  for (const file of files) {
    const source = await readFile(join(input.cwd, file), "utf8")
    if (!/useSafeRuntimeConfig|useRuntimeConfig|\$config/.test(source)) continue
    let blocks: ReturnType<typeof scriptBlocks>
    try {
      blocks = scriptBlocks(file, source)
    }
    catch (error) {
      result.followUps.push({ file, message: `Cannot parse this file (${error instanceof Error ? error.message : String(error)}). Check it by hand.` })
      continue
    }
    const state: FileState = {
      file,
      context: classify(file),
      output: new MagicString(source),
      followUps: [],
      secretReads: [],
      template: blocks.template,
      changed: false,
      remainingCalls: 0,
    }
    for (const block of blocks.blocks) {
      if (!/useSafeRuntimeConfig|useRuntimeConfig/.test(block.code)) continue
      try {
        new BlockRewriter(state, block, resolver).run()
      }
      catch (error) {
        state.followUps.push({ file, message: `Cannot rewrite this file (${error instanceof Error ? error.message : String(error)}). Check it by hand.` })
      }
    }
    if (blocks.template) templateConfigReads(state, blocks.template, resolver)
    result.followUps.push(...state.followUps)
    result.secretReads.push(...state.secretReads)
    if (state.remainingCalls) result.remaining.push(file)
    if (state.changed) result.edits.push({ path: file, before: source, after: state.output.toString() })
  }
  return result
}
