import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, findProperty, indentAt, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, ObjectExpression, ObjectProperty } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const configPatterns = ["{vite,nuxt}.config.{ts,mts,cts,js,mjs,cjs}"]
const definitionPatterns = ["server/auth.{ts,mts,cts,js,mjs,cjs}", "server.auth.{ts,mts,cts,js,mjs,cjs}"]
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.vitehub/**", "**/dist/**"]

interface Redirects {
  file: string
  line: number
  login?: string
  guest?: string
}

interface Parsed {
  code: string
  program: File
}

function parse(code: string, file: string): Parsed | undefined {
  try {
    return { code, program: parseProgram(code, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }) }
  }
  catch {
    return undefined
  }
}

function objectValue(property: ObjectProperty | undefined): ObjectExpression | undefined {
  const value = property && unwrapExpression(property.value)
  return value?.type === "ObjectExpression" ? value : undefined
}

function stringValue(property: ObjectProperty | undefined): string | undefined {
  const value = property && unwrapExpression(property.value)
  return value?.type === "StringLiteral" ? value.value : value?.type === "TemplateLiteral" && value.expressions.length === 0 ? value.quasis[0]?.value.cooked ?? undefined : undefined
}

/** The `auth` options of `vitehub()`: the `vitehub` key of a Nuxt config, the argument of `vitehub()`, or inline module options. */
function authOptionProperties(program: File): ObjectProperty[] {
  const found: ObjectProperty[] = []
  const take = (object: Node | undefined) => {
    const options = object && unwrapExpression(object)
    if (options?.type !== "ObjectExpression") return
    const auth = findProperty(options, "auth")
    if (auth) found.push(auth)
  }
  walk(program, (node) => {
    if (node.type === "ObjectProperty" && keyName(node.key, node.computed) === "vitehub") take(node.value)
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "vitehub") take(node.arguments[0] as Node | undefined)
    if (node.type === "ArrayExpression" && node.elements[0]?.type === "StringLiteral" && node.elements[0].value === "vite-hub/nuxt") take(node.elements[1] as Node | undefined)
  })
  return found
}

/** Inserts `text` as the last property of `object`, on its own line when the object spans lines. */
function appendProperty(output: MagicString, code: string, object: ObjectExpression, text: string) {
  const last = object.properties.at(-1)
  if (!last) {
    output.overwrite(start(object), end(object), `{ ${text} }`)
    return
  }
  const multiline = code.slice(start(object), start(object.properties[0]!)).includes("\n")
  let after = end(last)
  while (/[ \t]/.test(code[after] ?? "")) after++
  const comma = code[after] === ","
  if (multiline) {
    const indent = indentAt(code, start(last))
    output.appendLeft(comma ? after + 1 : end(last), `${comma ? "" : ","}\n${indent}${text}${comma ? "," : ""}`)
    return
  }
  output.appendLeft(end(last), `, ${text}`)
}

/** The options object of `defineAuth()`, or of the object that its callback returns. */
function definitionOptions(program: File): { object?: ObjectExpression, callback: boolean } {
  let result: { object?: ObjectExpression, callback: boolean } = { callback: false }
  walk(program, (node) => {
    if (result.object || node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "defineAuth") return
    const argument = node.arguments[0] && unwrapExpression(node.arguments[0] as Node)
    if (argument?.type === "ObjectExpression") result = { object: argument, callback: false }
    else if (argument?.type === "ArrowFunctionExpression" || argument?.type === "FunctionExpression") result = { callback: true }
  })
  return result
}

interface DefinitionEdit {
  afterSignIn?: string
  signIn?: string
}

/** Moves `signIn.callbackURL` to `afterSignIn`, and writes `signIn` and `afterSignIn` from `redirects`. */
function editDefinition(file: string, parsed: Parsed, moved: DefinitionEdit, followUps: FollowUp[]): string | undefined {
  const { code, program } = parsed
  const style = detectStyle(code, program)
  const output = new MagicString(code)
  const { object, callback } = definitionOptions(program)
  if (!object) {
    if (callback || moved.signIn !== undefined || moved.afterSignIn !== undefined) {
      followUps.push({ file, message: `Set \`access: { signIn, afterSignIn }\` in the options that \`defineAuth()\` returns${moved.signIn || moved.afterSignIn ? `: ${JSON.stringify({ signIn: moved.signIn, afterSignIn: moved.afterSignIn })}` : ""}. The page guard reads them at build time.` })
    }
    return undefined
  }
  const access = findProperty(object, "access")
  const accessObject = objectValue(access)
  const entries: string[] = []
  let afterSignIn = moved.afterSignIn
  if (accessObject) {
    const signIn = findProperty(accessObject, "signIn")
    const provider = objectValue(signIn)
    const callbackURL = provider && findProperty(provider, "callbackURL")
    if (callbackURL) {
      const value = stringValue(callbackURL)
      if (value === undefined || (afterSignIn !== undefined && afterSignIn !== value)) {
        followUps.push({ file, line: line(callbackURL), message: "`access.signIn.callbackURL` moved to `access.afterSignIn`. Move it by hand, and keep one page for signed-in users." })
      }
      else {
        const [from, to] = listItemRemoval(code, callbackURL)
        output.remove(from, to)
        afterSignIn = value
      }
    }
    if (moved.signIn !== undefined) {
      if (!signIn) entries.push(`signIn: ${quoteString(moved.signIn, style)}`)
      else if (stringValue(signIn) !== moved.signIn) {
        followUps.push({ file, line: line(signIn), message: `\`vitehub({ auth: { redirects: { login } } })\` sent visitors to ${JSON.stringify(moved.signIn)}, and \`access.signIn\` is set too. Keep one: the path of your sign-in page, or the provider that the Auth route starts.` })
      }
    }
    const existing = findProperty(accessObject, "afterSignIn")
    if (afterSignIn !== undefined && !existing) entries.push(`afterSignIn: ${quoteString(afterSignIn, style)}`)
    else if (afterSignIn !== undefined && existing && stringValue(existing) !== afterSignIn) {
      followUps.push({ file, line: line(existing), message: `Signed-in users went to ${JSON.stringify(afterSignIn)}, and \`access.afterSignIn\` is set too. Keep one page.` })
    }
    for (const entry of entries) appendProperty(output, code, accessObject, entry)
  }
  else if (access) {
    followUps.push({ file, line: line(access), message: `Set \`signIn\` and \`afterSignIn\` in \`access\` by hand: ${JSON.stringify(moved)}.` })
  }
  else if (moved.signIn !== undefined || afterSignIn !== undefined) {
    const values = [
      ...moved.signIn === undefined ? [] : [`signIn: ${quoteString(moved.signIn, style)}`],
      ...afterSignIn === undefined ? [] : [`afterSignIn: ${quoteString(afterSignIn, style)}`],
    ]
    appendProperty(output, code, object, `access: { ${values.join(", ")} }`)
  }
  return output.hasChanged() ? output.toString() : undefined
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const redirects: Redirects[] = []
  for (const file of (await glob(configPatterns, { cwd, ignore: ignored })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!/\bredirects\b/.test(code)) continue
    const parsed = parse(code, file)
    if (!parsed) continue
    const output = new MagicString(code)
    for (const auth of authOptionProperties(parsed.program)) {
      const options = objectValue(auth)
      const property = options && findProperty(options, "redirects")
      if (!property) continue
      const value = objectValue(property)
      const login = value && findProperty(value, "login")
      const guest = value && findProperty(value, "guest")
      const readable = value && value.properties.every(entry => entry.type === "ObjectProperty" && ["login", "guest"].includes(keyName(entry.key, entry.computed) ?? ""))
        && (!login || stringValue(login) !== undefined) && (!guest || stringValue(guest) !== undefined)
        && options.properties.length === 1
      if (!readable) {
        followUps.push({ file, line: line(property), message: "`vitehub({ auth: { redirects } })` was removed. Set `access: { signIn: '<sign-in page>', afterSignIn: '<page for signed-in users>' }` in `server/auth.ts`, then remove `auth` from `vitehub()`." })
        continue
      }
      redirects.push({ file, line: line(property), login: stringValue(login), guest: stringValue(guest) })
      const [from, to] = listItemRemoval(code, auth)
      output.remove(from, to)
    }
    if (output.hasChanged()) edits.push({ path: file, before: code, after: output.toString() })
  }

  const moved: DefinitionEdit = {
    signIn: redirects.find(entry => entry.login !== undefined)?.login,
    afterSignIn: redirects.find(entry => entry.guest !== undefined)?.guest,
  }
  const definitions = (await glob(definitionPatterns, { cwd, ignore: ignored })).sort()
  const [definition] = definitions
  if (!definition) {
    if (redirects.length) {
      followUps.push({ file: redirects[0]!.file, line: redirects[0]!.line, message: `Add \`access: ${JSON.stringify(moved)}\` to \`defineAuth()\` in \`server/auth.ts\`. The codemod removed \`auth.redirects\` from \`vitehub()\`.` })
    }
  }
  else {
    const code = await readFile(join(cwd, definition), "utf8")
    const parsed = /\bdefineAuth\b/.test(code) ? parse(code, definition) : undefined
    const after = parsed && (redirects.length || /\bcallbackURL\b/.test(code)) ? editDefinition(definition, parsed, moved, followUps) : undefined
    if (after) edits.push({ path: definition, before: code, after })
  }

  return {
    summary: edits.length ? `moved the Auth sign-in pages into server/auth.ts in ${edits.length} file(s)` : "found no Auth redirects or signIn.callbackURL",
    edits,
    followUps,
    notes: redirects.length ? ["`access.signIn` is now the page that the Nuxt page guard opens for a signed-out visitor, and `access.afterSignIn` the page for a signed-in user on an `auth: 'guest'` page."] : [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const authSignIn: Codemod = {
  name: "auth-sign-in",
  description: "Move `vitehub({ auth: { redirects } })` and `access.signIn.callbackURL` to `access: { signIn, afterSignIn }` in server/auth.ts",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} sets an Auth sign-in page in the old place` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} sets an Auth sign-in page in the old place` } : undefined
  },
  run: migrate,
}
