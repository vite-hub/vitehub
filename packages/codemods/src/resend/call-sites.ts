import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, isReference, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { CallExpression, File, Identifier, ImportDeclaration, ObjectExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FileEdit, FollowUp } from "../types.ts"

const emailImport = "vite-hub/email"

/** Message fields that the ViteHub Resend driver sends. Resend's `reply_to` becomes `replyTo`. */
const portableFields = new Set(["from", "to", "cc", "bcc", "replyTo", "subject", "html", "text", "headers", "attachments"])

export interface ResendCallSites {
  edits: FileEdit[]
  followUps: FollowUp[]
  /** Variables that `new Resend()` calls read, such as `RESEND_API_KEY`. */
  apiKeyVariables: string[]
  /** Top-level `runtimeConfig` keys that `new Resend()` calls read, such as `resendApiKey`. */
  runtimeConfigKeys: string[]
  /** Distinct credential sources used by clients, for the manual account check. */
  apiKeySources: string[]
  /** Files that still use the Resend SDK or `useResend()`. */
  remaining: string[]
  /** Files that still call `useResend()`, which needs the nuxt-resend module. */
  useResendRemaining: string[]
  /** Number of `emails.send()` calls rewritten. */
  sends: number
}

function processEnvName(node: Node | undefined, resolveBinding: ReturnType<typeof bindingResolver>): string | undefined {
  if (node?.type !== "MemberExpression" || node.object.type !== "MemberExpression") return undefined
  const object = node.object
  if (object.object.type !== "Identifier" || object.object.name !== "process" || keyName(object.property) !== "env") return undefined
  if (resolveBinding(object.object)) return undefined
  return keyName(node.property, node.computed)
}

/** True when the file declares or reads a binding named `name`, so a new import must use another name. */
function nameTaken(program: File, name: string): boolean {
  let taken = false
  walk(program, (node) => {
    if (node.type === "Identifier" && node.name === name) taken = true
  })
  return taken
}

class FileRewrite {
  readonly output: MagicString
  readonly followUps: FollowUp[] = []
  changed = false
  sends = 0
  keepsResend = false
  keepsUseResend = false
  readonly apiKeyVariables: string[] = []
  readonly apiKeySources: string[] = []
  /** Top-level `runtimeConfig` keys that `new Resend()` reads, such as `resendApiKey`. */
  readonly runtimeConfigKeys: string[] = []
  private readonly program: File
  private readonly mailer: string
  private readonly removedStatements = new Set<Node>()
  /** Source ranges that the rewrite replaced. */
  private readonly replaced: Array<[number, number]> = []
  private readonly useResendBindings = new Set<Identifier>()
  private readonly resendClassBindings = new Set<Identifier>()
  private readonly runtimeConfigHelpers = new Set<Identifier>()
  private readonly runtimeConfigObjects = new Set<Identifier>()
  private readonly resolveBinding: ReturnType<typeof bindingResolver>

  constructor(private readonly file: string, private readonly code: string) {
    this.output = new MagicString(code)
    this.program = parseProgram(code, { typescript: !/\.(?:c|m)?js$/.test(file), jsx: file.endsWith("x") })
    this.resolveBinding = bindingResolver(this.program)
    this.mailer = nameTaken(this.program, "email") ? "viteHubEmail" : "email"
    for (const statement of this.program.program.body) {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
        const imported = keyName(specifier.imported)
        if (statement.source.value === "resend" && imported === "Resend") this.resendClassBindings.add(specifier.local)
        if (statement.source.value === "#imports" && imported === "useResend") this.useResendBindings.add(specifier.local)
        if (statement.source.value === "#imports" && imported === "useRuntimeConfig") this.runtimeConfigHelpers.add(specifier.local)
      }
    }
    walk(this.program, (node, ancestors) => {
      // Mutable aliases cannot prove where a later credential comes from.
      const statement = ancestors.at(-1)
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && statement?.type === "VariableDeclaration"
        && statement.kind === "const" && this.isRuntimeConfigCall(node.init)) this.runtimeConfigObjects.add(node.id)
    })
  }

  private follow(node: Node, message: string): void {
    this.followUps.push({ file: this.file, line: line(node), message })
  }

  private isClient(node: Node): boolean {
    if ((node.type !== "CallExpression" && node.type !== "NewExpression") || node.callee.type !== "Identifier") return false
    const binding = this.resolveBinding(node.callee)
    if (node.type === "NewExpression") return binding !== undefined && this.resendClassBindings.has(binding)
    // nuxt-resend also auto-imports useResend() when no lexical binding shadows it.
    return binding ? this.useResendBindings.has(binding) : node.callee.name === "useResend"
  }

  hasClient(): boolean {
    let found = false
    walk(this.program, (node) => { if (this.isClient(node)) found = true })
    return found
  }

  run(): void {
    const clients: Array<{ node: Node, ancestors: Node[] }> = []
    walk(this.program, (node, ancestors) => {
      if (this.isClient(node)) clients.push({ node, ancestors: [...ancestors] })
    })
    for (const client of clients) {
      const before = this.keepsResend
      this.keepsResend = false
      this.planClient(client.node, client.ancestors)
      if (this.keepsResend && client.node.type === "CallExpression") this.keepsUseResend = true
      this.keepsResend ||= before
    }
    this.updateImports()
  }

  /** The key of `useRuntimeConfig().key`, or of `config.key` where `const config = useRuntimeConfig()`. */
  private runtimeConfigKey(node: Node): string | undefined {
    if (node.type !== "MemberExpression") return undefined
    const key = keyName(node.property, node.computed)
    const object = node.object
    if (this.isRuntimeConfigCall(object)) return key
    if (object.type !== "Identifier") return undefined
    const binding = this.resolveBinding(object)
    return binding && this.runtimeConfigObjects.has(binding) ? key : undefined
  }

  private isRuntimeConfigCall(node: Node | null | undefined): boolean {
    if (node?.type !== "CallExpression" || node.callee.type !== "Identifier") return false
    const binding = this.resolveBinding(node.callee)
    return binding ? this.runtimeConfigHelpers.has(binding) : node.callee.name === "useRuntimeConfig"
  }

  private planClient(client: Node, ancestors: Node[]): void {
    if (client.type === "NewExpression") {
      const [argument] = client.arguments
      const name = argument ? processEnvName(argument, this.resolveBinding) : "RESEND_API_KEY"
      const runtimeKey = argument ? this.runtimeConfigKey(argument) : undefined
      this.apiKeySources.push(name ? `env:${name}` : runtimeKey ? `runtimeConfig:${runtimeKey}` : `${this.file}:${start(client)}`)
      if (name) this.apiKeyVariables.push(name)
      else if (runtimeKey) this.runtimeConfigKeys.push(runtimeKey)
      else if (argument) this.follow(client, "new Resend() reads its API key from an expression. Declare that value as vitehub.email.options.apiKey by hand.")
    }
    else this.apiKeySources.push("nuxt-resend")
    const parent = ancestors.at(-1)
    // useResend().emails.send(message)
    if (parent?.type === "MemberExpression" && parent.object === client && keyName(parent.property, parent.computed) === "emails") {
      this.planEmails(parent, ancestors.slice(0, -1))
      return
    }
    if (parent?.type === "VariableDeclarator" && parent.init === client) {
      const statement = ancestors.at(-2)?.type === "VariableDeclaration" ? ancestors.at(-2) : undefined
      if (parent.id.type === "Identifier") {
        const uses = this.references(parent.id)
        const rewritten = uses.filter(use => use.parent?.type === "MemberExpression" && use.parent.object === use.node && keyName(use.parent.property, use.parent.computed) === "emails")
        for (const use of rewritten) this.planEmails(use.parent!, use.ancestors.slice(0, -1))
        const other = uses.filter(use => !rewritten.includes(use))
        for (const use of other) this.follow(use.node, `${parent.id.name} is used for more than emails.send(), such as batch, contacts, or audiences. Those stay on the Resend SDK.`)
        if (!this.keepsResend && !other.length && rewritten.length && statement) this.removeDeclarator(statement, parent)
        else this.keepsResend = true
        return
      }
      if (parent.id.type === "ObjectPattern") {
        const property = parent.id.properties.find(entry => entry.type === "ObjectProperty" && keyName(entry.key) === "emails")
        const local = property?.type === "ObjectProperty" && property.value.type === "Identifier" ? property.value : undefined
        if (local && parent.id.properties.length === 1) {
          const uses = this.references(local)
          const sends = uses.filter(use => use.parent?.type === "MemberExpression" && use.parent.object === use.node && keyName(use.parent.property, use.parent.computed) === "send")
          for (const use of sends) this.planSend(use.parent!, use.ancestors.slice(0, -1))
          if (!this.keepsResend && sends.length === uses.length && sends.length && statement) this.removeDeclarator(statement, parent)
          else {
            for (const use of uses.filter(entry => !sends.includes(entry))) this.follow(use.node, `This code uses ${local.name} for more than send(). Those calls stay on the Resend SDK.`)
            this.keepsResend = true
          }
          return
        }
      }
    }
    this.follow(client, "This Resend client is used in a way the codemod does not rewrite, such as a class field or an argument. Replace its emails.send() calls with email.send() from vite-hub/email.")
    this.keepsResend = true
  }

  /** `X.emails` where `.send(message)` follows. `ancestors` end with the parent of `emails`. */
  private planEmails(emails: Node, ancestors: Node[]): void {
    const parent = ancestors.at(-1)
    if (parent?.type === "MemberExpression" && parent.object === emails && keyName(parent.property, parent.computed) === "send") {
      this.planSend(parent, ancestors.slice(0, -1))
      return
    }
    this.follow(emails, "This code reads resend.emails without calling send(). Rewrite it by hand.")
    this.keepsResend = true
  }

  /** `<object>.send`, whose parent is the call. `ancestors` end with the call. Rewrites the callee, the message, and the result. */
  private planSend(member: Node, ancestors: Node[]): void {
    const call = ancestors.at(-1)
    if (call?.type !== "CallExpression" || call.callee !== member) {
      this.follow(member, "send() is passed on instead of called. Rewrite it by hand with email.send().")
      this.keepsResend = true
      return
    }
    // For `useResend().emails.send`, the callee range covers the client call too.
    this.output.overwrite(start(member), end(member), `${this.mailer}.send`)
    this.replaced.push([start(member), end(member)])
    this.changed = true
    this.sends++
    this.planMessage(call)
    this.planResult(call, ancestors.slice(0, -1))
  }

  private planMessage(call: CallExpression): void {
    const [message, options] = call.arguments
    if (options) this.follow(call, "send() received request options, such as an idempotency key. email.send() takes only the message.")
    if (message?.type !== "ObjectExpression") {
      this.follow(call, "The message is not an object literal, so the codemod could not check its fields. ViteHub uses replyTo instead of Resend's reply_to, and does not send react.")
      return
    }
    this.planFields(message)
  }

  private planFields(message: ObjectExpression): void {
    for (const property of message.properties) {
      if (property.type !== "ObjectProperty") {
        if (property.type === "SpreadElement") this.follow(property, "The message spreads another object. Check that it uses replyTo instead of reply_to.")
        continue
      }
      const key = keyName(property.key, property.computed)
      if (key === "reply_to") {
        const shorthand = property.shorthand
        this.output.overwrite(start(property.key), end(property.key), "replyTo")
        if (shorthand) this.output.appendLeft(end(property.key), ": reply_to")
      }
      else if (key === "react") this.follow(property, "ViteHub Email does not send React elements. Render the element to html first, for example with render() from @react-email/render.")
      else if (key && !portableFields.has(key)) this.follow(property, `The ${key} field is not one of the portable Email fields. Check that the ViteHub Resend driver sends it.`)
    }
  }

  /** Resend returns `{ data, error }`. ViteHub returns `[error, sent]`. */
  private planResult(call: CallExpression, ancestors: Node[]): void {
    let index = ancestors.length - 1
    let node: Node = call
    if (ancestors[index]?.type === "AwaitExpression") {
      node = ancestors[index]!
      index--
    }
    const parent = ancestors[index]
    if (parent?.type === "ExpressionStatement") return
    if (parent?.type === "VariableDeclarator" && parent.init === node && parent.id.type === "ObjectPattern") {
      const names = new Map<string, string>()
      for (const property of parent.id.properties) {
        const key = property.type === "ObjectProperty" ? keyName(property.key) : undefined
        if (property.type !== "ObjectProperty" || (key !== "data" && key !== "error") || property.value.type !== "Identifier") {
          this.follow(parent, "The result destructuring has a field other than data and error. email.send() returns an [error, sent] tuple. Rewrite it by hand.")
          return
        }
        names.set(key, property.value.name)
      }
      const error = names.get("error") ?? ""
      const data = names.get("data")
      this.output.overwrite(start(parent.id), end(parent.id.typeAnnotation ?? parent.id), data ? `[${error}, ${data}]` : `[${error}]`)
      if (data) this.follow(parent, `${data} is now ViteHub's EmailSendResult, { id, driver }. Resend's data had { id }.`)
      return
    }
    this.follow(call, "email.send() returns an [error, sent] tuple, where Resend returned { data, error }. Update the code that reads this result.")
  }

  private references(declaration: Identifier): Array<{ node: Node, parent?: Node, ancestors: Node[] }> {
    const uses: Array<{ node: Node, parent?: Node, ancestors: Node[] }> = []
    walk(this.program, (node, ancestors) => {
      if (node === declaration || !isReference(node, ancestors.at(-1)) || this.resolveBinding(node) !== declaration) return
      uses.push({ node, parent: ancestors.at(-1), ancestors: [...ancestors] })
    })
    return uses
  }

  private removeDeclarator(statement: Node, declarator: Node): void {
    if (statement.type === "VariableDeclaration" && statement.declarations.length === 1) {
      let to = end(statement)
      while (to < this.code.length && /[ \t]/.test(this.code[to] ?? "")) to++
      if (this.code[to] === "\n") to++
      const lineStart = this.code.lastIndexOf("\n", start(statement) - 1) + 1
      const from = /^[ \t]*$/.test(this.code.slice(lineStart, start(statement))) ? lineStart : start(statement)
      // After a blank line or an opening brace, also drop the blank line that follows.
      const previousBlank = /(?:\n[ \t]*\n|\{[ \t]*\n)$/.test(this.code.slice(0, from))
      const next = /^[ \t]*\n/.exec(this.code.slice(to))
      if (previousBlank && next) to += next[0].length
      this.output.remove(from, to)
      this.removedStatements.add(statement)
      this.changed = true
      return
    }
    const range = listItemRemoval(this.code, declarator)
    this.output.remove(range[0], range[1])
    this.changed = true
  }

  private updateImports(): void {
    if (!this.sends) return
    const style = detectStyle(this.code, this.program)
    const semicolon = style.semicolons ? ";" : ""
    const imports = this.program.program.body.filter((statement): statement is ImportDeclaration => statement.type === "ImportDeclaration")
    const stillUsed = (binding: Identifier) => {
      return this.references(binding).some(({ node, ancestors }) => {
        const replaced = this.replaced.some(([from, to]) => start(node) >= from && end(node) <= to)
        return !ancestors.some(ancestor => this.removedStatements.has(ancestor)) && !replaced
      })
    }
    const text = `import { ${this.mailer === "email" ? "email" : "email as viteHubEmail"} } from ${quoteString(emailImport, style)}${semicolon}`
    let placed = false
    const kept: ImportDeclaration[] = []
    for (const statement of imports) {
      const removable = statement.specifiers.filter((specifier) => {
        const ours = this.resendClassBindings.has(specifier.local) || this.useResendBindings.has(specifier.local)
        return ours && !this.keepsResend && !stillUsed(specifier.local)
      })
      if (removable.length && removable.length === statement.specifiers.length) {
        // Put the new import where the removed one was.
        if (!placed) this.output.overwrite(start(statement), end(statement), text)
        else this.output.remove(start(statement), this.code[end(statement)] === "\n" ? end(statement) + 1 : end(statement))
        placed = true
        continue
      }
      for (const specifier of removable) {
        const range = listItemRemoval(this.code, specifier)
        this.output.remove(range[0], range[1])
      }
      kept.push(statement)
    }
    if (placed) return
    const last = kept.at(-1)
    if (last) this.output.appendLeft(end(last), `\n${text}`)
    else this.output.prepend(`${text}\n\n`)
  }
}

/** Use the same import and lexical-binding rules for discovery and migration. */
export function hasResendClient(file: string, code: string): boolean {
  try {
    return new FileRewrite(file, code).hasClient()
  }
  catch {
    return false
  }
}

/** Rewrites `emails.send()` calls of `useResend()` and `new Resend()` clients in server code. */
export async function rewriteResendCallSites(cwd: string): Promise<ResendCallSites> {
  const files = await glob(["**/*.{ts,mts,cts,js,mjs,cjs}"], { cwd, ignore: ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/dist/**", "nuxt.config.*"] })
  const result: ResendCallSites = { edits: [], followUps: [], apiKeyVariables: [], runtimeConfigKeys: [], apiKeySources: [], remaining: [], useResendRemaining: [], sends: 0 }
  for (const file of files.sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!/useResend|from\s+["']resend["']/.test(code)) continue
    let rewrite: FileRewrite
    try {
      rewrite = new FileRewrite(file, code)
      rewrite.run()
    }
    catch {
      result.followUps.push({ file, message: "The codemod could not parse this file. Replace its Resend calls with email.send() from vite-hub/email by hand." })
      result.remaining.push(file)
      if (code.includes("useResend")) result.useResendRemaining.push(file)
      continue
    }
    result.followUps.push(...rewrite.followUps)
    result.apiKeyVariables.push(...rewrite.apiKeyVariables)
    result.apiKeySources.push(...rewrite.apiKeySources)
    result.runtimeConfigKeys.push(...rewrite.runtimeConfigKeys)
    result.sends += rewrite.sends
    if (rewrite.keepsResend) result.remaining.push(file)
    if (rewrite.keepsUseResend) result.useResendRemaining.push(file)
    if (rewrite.changed) result.edits.push({ path: file, before: code, after: rewrite.output.toString() })
  }
  return result
}
