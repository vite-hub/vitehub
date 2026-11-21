import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, Identifier, ObjectExpression, ObjectProperty } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

type Kind = "mcp" | "realtime"

/** The define functions whose options object changed its access key, by the modules that export them. */
const defines = new Map<string, { kind: Kind, sources: readonly string[] }>([
  ["defineRealtime", { kind: "realtime", sources: ["vite-hub/realtime", "@vite-hub/realtime"] }],
  ...["defineMcpTool", "defineMcpPrompt", "defineMcpResource"].map(name => [name, { kind: "mcp" as const, sources: ["vite-hub/mcp", "@vite-hub/mcp"] }] as const),
])

/** Files whose default export is a definition, also as a plain object. */
const definitionFiles: ReadonlyArray<readonly [RegExp, Kind]> = [
  [/(?:^|\/)server\/realtime\/.+$/, "realtime"],
  [/(?:^|\/)server\/mcp\/(?:tools|prompts|resources)\/.+$/, "mcp"],
]

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /\bauth\b|\bpublic\b/

interface FileContext {
  code: string
  file: string
  followUps: FollowUp[]
  output: MagicString
  quote: string
  changed: number
}

/** The local names of the define functions that the file imports. Nuxt auto-imports `defineRealtime`, so a free name counts too. */
function defineOf(program: File, resolve: (node: Identifier) => Identifier | undefined): (callee: Node) => Kind | undefined {
  const imported = new Map<Identifier, Kind>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue
      const entry = defines.get(keyName(specifier.imported) ?? "")
      if (entry?.sources.includes(statement.source.value)) imported.set(specifier.local, entry.kind)
    }
  }
  return (callee) => {
    if (callee.type !== "Identifier") return undefined
    const binding = resolve(callee)
    if (binding) return imported.get(binding)
    return defines.get(callee.name)?.kind
  }
}

function propertyName(entry: ObjectExpression["properties"][number]): string | undefined {
  return entry.type === "SpreadElement" ? undefined : keyName(entry.key, entry.computed)
}

function readRule(context: FileContext, object: ObjectExpression, legacy: "auth" | "public", current: "authorize" | "access") {
  const rules = object.properties.filter(entry => propertyName(entry) === legacy)
  const [rule] = rules
  if (!rule) return
  if (rules.length !== 1 || rule.type !== "ObjectProperty" || object.properties.some(entry => propertyName(entry) === undefined)
    || (legacy === "public" && object.properties.some(entry => propertyName(entry) === current))) {
    context.followUps.push({ file: context.file, line: line(rule), message: `Check which access rule this definition uses after its properties are combined. Replace \`${legacy}\` by hand with \`${current}\` without changing who can use it.` })
    return
  }
  return rule
}

/** Removes one property and the comma that separates it from its neighbor. */
function remove(context: FileContext, object: ObjectExpression, entry: ObjectProperty) {
  const index = object.properties.indexOf(entry)
  const next = object.properties[index + 1]
  const previous = object.properties[index - 1]
  if (next) context.output.remove(start(entry), start(next))
  else if (previous) context.output.remove(end(previous), end(entry))
  else context.output.remove(start(entry), end(object) - 1)
  context.changed++
}

/** `auth: true` becomes `authorize: true`. Next to `authorize()`, `auth: true` needs a person: the callback now also runs signed out. */
function rewriteRealtime(context: FileContext, object: ObjectExpression) {
  const auth = readRule(context, object, "auth", "authorize")
  if (!auth) return
  const value = auth.value
  if (value.type === "BooleanLiteral" && !value.value) {
    // `auth: false` was the default. An `authorize()` callback already ran for signed-out callers with it.
    remove(context, object, auth)
    return
  }
  const authorize = object.properties.some(entry => propertyName(entry) === "authorize")
  if (value.type !== "BooleanLiteral" || authorize || object.properties.some(entry => propertyName(entry) === "access")) {
    context.followUps.push({
      file: context.file,
      line: line(auth),
      message: authorize
        ? "Realtime replaced `auth: true` with `authorize: true`, and an `authorize()` callback now also runs for signed-out callers, with `user: null`. Remove `auth`, and return `false` from `authorize()` when `user` is `null`. Until then, the server rejects this definition with `REALTIME_INVALID_ACCESS`."
        : "Realtime replaced `auth: true` with `authorize: true`. Check the effective access and set one of `authorize: true`, `authorize()`, or `access: \"public\"` in place of `auth`.",
    })
    return
  }
  context.output.overwrite(start(auth.key), end(auth.key), auth.computed ? `${context.quote}authorize${context.quote}` : "authorize")
  context.changed++
}

/** `public: true` becomes `access: "public"`, and `public: false` goes away. */
function rewriteMcp(context: FileContext, object: ObjectExpression) {
  const flag = readRule(context, object, "public", "access")
  if (!flag) return
  if (flag.value.type === "BooleanLiteral") {
    if (flag.value.value) {
      context.output.overwrite(start(flag), end(flag), `access: ${context.quote}public${context.quote}`)
      context.changed++
    }
    else {
      remove(context, object, flag)
    }
    return
  }
  context.followUps.push({ file: context.file, line: line(flag), message: "MCP replaced `public: true` with `access: \"public\"` on tools, prompts, and resources. Set `access: \"public\"` when this value is `true`, else remove `public`." })
}

function rewrite(context: FileContext, kind: Kind, node: Node | null | undefined) {
  const object = node && unwrapExpression(node)
  if (object?.type !== "ObjectExpression") return
  if (kind === "realtime") rewriteRealtime(context, object)
  else rewriteMcp(context, object)
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of files) {
    const code = await readFile(join(cwd, file), "utf8")
    const fileKind = definitionFiles.find(([pattern]) => pattern.test(file))?.[1]
    if (!needle.test(code) || (!fileKind && ![...defines.keys()].some(name => code.includes(name)))) continue
    let program: File
    try {
      program = parseProgram(code, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) })
    }
    catch (error) {
      followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Rename Realtime \`auth: true\` to \`authorize: true\` and MCP \`public: true\` to \`access: "public"\` by hand.` })
      continue
    }
    const firstImport = program.program.body.find(statement => statement.type === "ImportDeclaration")
    const context: FileContext = { code, file, followUps, output: new MagicString(code), quote: firstImport ? code[start(firstImport.source)]! : "\"", changed: 0 }
    const kindOf = defineOf(program, bindingResolver(program))
    walk(program, (node) => {
      if (node.type === "CallExpression") {
        const kind = kindOf(node.callee)
        if (kind) rewrite(context, kind, node.arguments[0])
        return
      }
      if (fileKind && node.type === "ExportDefaultDeclaration") rewrite(context, fileKind, node.declaration)
    })
    if (context.changed) edits.push({ path: file, before: code, after: context.output.toString() })
  }
  return {
    summary: edits.length ? `moved Realtime and MCP access to authorize and access in ${edits.length} file(s)` : "found no Realtime auth or MCP public key",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length || followUps.length ? ["Run your typecheck."] : [],
  }
}

export const accessSpellings: Codemod = {
  name: "access-spellings",
  description: "Rename Realtime `auth: true` to `authorize: true`, and MCP `public: true` to `access: \"public\"`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} sets Realtime \`auth\` or MCP \`public\`` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} needs the Realtime \`authorize\` or MCP \`access\` change` } : undefined
  },
  run: migrate,
}
