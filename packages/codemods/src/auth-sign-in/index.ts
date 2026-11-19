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
  range: [number, number]
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

function isAppPath(value: string): boolean {
  return /^\/(?![/\\])/.test(value)
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
function appendProperties(output: MagicString, code: string, object: ObjectExpression, entries: string[]) {
  if (!entries.length) return
  const last = object.properties.at(-1)
  if (!last) {
    output.appendLeft(start(object) + 1, ` ${entries.join(", ")} `)
    return
  }
  const multiline = code.slice(start(object), start(object.properties[0]!)).includes("\n")
  let after = end(last)
  while (/[ \t]/.test(code[after] ?? "")) after++
  const comma = code[after] === ","
  if (multiline) {
    const indent = indentAt(code, start(last))
    output.appendLeft(comma ? after + 1 : end(last), `${comma ? "" : ","}\n${indent}${entries.join(`,\n${indent}`)}${comma ? "," : ""}`)
    return
  }
  output.appendLeft(end(last), `, ${entries.join(", ")}`)
}

function callbackOptions(callback: Extract<Node, { type: "ArrowFunctionExpression" }>): ObjectExpression | undefined {
  if (callback.body.type !== "BlockStatement") {
    const value = unwrapExpression(callback.body)
    return value.type === "ObjectExpression" ? value : undefined
  }
  const last = callback.body.body.at(-1)
  if (last?.type !== "ReturnStatement" || !last.argument) return
  const value = unwrapExpression(last.argument)
  if (value.type !== "ObjectExpression") return
  let returns = 0
  walk(callback.body, (node, ancestors) => {
    if (node.type === "ReturnStatement" && !ancestors.some(parent => ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(parent.type))) returns++
  })
  return returns === 1 ? value : undefined
}

/** The options object of `defineAuth()`, or the one object its callback returns. */
function definitionOptions(program: File): { object?: ObjectExpression, callback: boolean } {
  let result: { object?: ObjectExpression, callback: boolean } = { callback: false }
  walk(program, (node) => {
    if (result.object || node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "defineAuth") return
    const argument = node.arguments[0] && unwrapExpression(node.arguments[0] as Node)
    if (argument?.type === "ObjectExpression") result = { object: argument, callback: false }
    else if (argument?.type === "ArrowFunctionExpression") result = { object: callbackOptions(argument), callback: true }
    else if (argument?.type === "FunctionExpression") result = { callback: true }
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
      if (value !== undefined && !isAppPath(value)) {
        followUps.push({ file, line: line(callbackURL), message: `Move \`access.signIn.callbackURL\` (${JSON.stringify(value)}) to \`access.afterSignIn\` by hand. Use a path of the app, such as '/dashboard'.` })
      }
      else if (value === undefined || (afterSignIn !== undefined && afterSignIn !== value)) {
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
    appendProperties(output, code, accessObject, entries)
  }
  else if (access) {
    followUps.push({ file, line: line(access), message: `Set \`signIn\` and \`afterSignIn\` in \`access\` by hand: ${JSON.stringify(moved)}.` })
  }
  else if (moved.signIn !== undefined || afterSignIn !== undefined) {
    const values = [
      ...moved.signIn === undefined ? [] : [`signIn: ${quoteString(moved.signIn, style)}`],
      ...afterSignIn === undefined ? [] : [`afterSignIn: ${quoteString(afterSignIn, style)}`],
    ]
    appendProperties(output, code, object, [`access: { ${values.join(", ")} }`])
  }
  return output.hasChanged() ? output.toString() : undefined
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const redirects: Redirects[] = []
  const configFiles = new Map<string, string>()
  for (const file of (await glob(configPatterns, { cwd, ignore: ignored })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!/\bredirects\b/.test(code)) continue
    const parsed = parse(code, file)
    if (!parsed) continue
    configFiles.set(file, code)
    for (const auth of new Set(authOptionProperties(parsed.program))) {
      const options = objectValue(auth)
      const property = options && findProperty(options, "redirects")
      if (!property) continue
      const value = objectValue(property)
      const login = value && findProperty(value, "login")
      const guest = value && findProperty(value, "guest")
      const readable = value && value.properties.every(entry => entry === login || entry === guest)
        && (!login || stringValue(login) !== undefined) && (!guest || stringValue(guest) !== undefined)
        && options.properties.length === 1
      if (!readable) {
        followUps.push({ file, line: line(property), message: "`vitehub({ auth: { redirects } })` was removed. Set `access: { signIn: '<sign-in page>', afterSignIn: '<page for signed-in users>' }` in `server/auth.ts`, then remove `auth` from `vitehub()`." })
        continue
      }
      for (const [key, setting] of [["login", login], ["guest", guest]] as const) {
        const path = stringValue(setting)
        if (setting && path !== undefined && !isAppPath(path)) {
          followUps.push({ file, line: line(setting), message: `Move \`auth.redirects.${key}\` (${JSON.stringify(path)}) by hand. Use a path of the app, such as '/dashboard'.` })
        }
      }
      redirects.push({ file, line: line(property), login: stringValue(login), guest: stringValue(guest), range: listItemRemoval(code, auth) })
    }
  }

  for (const key of ["login", "guest"] as const) {
    const sources = redirects.filter(entry => entry[key] !== undefined)
    const values = [...new Set(sources.map(entry => entry[key]))]
    if (values.length < 2) continue
    for (const { file, line } of sources) {
      followUps.push({ file, line, message: `Conflicting \`auth.redirects.${key}\` values (${values.map(value => JSON.stringify(value)).join(", ")}). Move them to the Auth Definition by hand.` })
    }
  }
  const moved: DefinitionEdit = {
    signIn: redirects.find(entry => entry.login !== undefined)?.login,
    afterSignIn: redirects.find(entry => entry.guest !== undefined)?.guest,
  }
  const definitions = (await glob(definitionPatterns, { cwd, ignore: ignored })).sort()
  const [definition] = definitions
  if (!followUps.length) {
    if (definitions.length !== 1) {
      const source = redirects[0]
      if (source) followUps.push({ file: source.file, line: source.line, message: "Move `auth.redirects` by hand: the codemod could not find a single Auth Definition." })
    }
    else if (definition) {
      const code = await readFile(join(cwd, definition), "utf8")
      const parsed = /\bdefineAuth\b/.test(code) ? parse(code, definition) : undefined
      if (!parsed && redirects.length) {
        followUps.push({ file: definition, message: "Move `auth.redirects` by hand: the codemod could not read the Auth Definition." })
      }
      const after = parsed && (redirects.length || /\bcallbackURL\b/.test(code)) ? editDefinition(definition, parsed, moved, followUps) : undefined
      if (after) edits.push({ path: definition, before: code, after })
    }
  }
  if (followUps.length) {
    edits.length = 0
  }
  else {
    for (const [file, code] of configFiles) {
      const output = new MagicString(code)
      for (const entry of redirects) if (entry.file === file) output.remove(...entry.range)
      if (output.hasChanged()) edits.push({ path: file, before: code, after: output.toString() })
    }
  }

  return {
    summary: edits.length ? `moved the Auth sign-in pages into server/auth.ts in ${edits.length} file(s)` : followUps.length ? "left the Auth sign-in settings for manual migration" : "found no Auth redirects or signIn.callbackURL",
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
