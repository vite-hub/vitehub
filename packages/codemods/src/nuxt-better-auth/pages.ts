import { end, findProperty, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"

import { literalValue, unwrapExpression } from "../shared/nuxt-config.ts"

import type { CallExpression, ObjectExpression, ObjectProperty } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"

/** One `auth` route rule: its pattern and the page meta it becomes. */
export interface AuthRouteRule {
  pattern: string
  /** Source of the ViteHub page meta, such as `'user'` or `{ only: 'guest', redirectTo: '/app' }`. */
  meta: string
  /** `true` when the rule allows only signed-in users. */
  user: boolean
  /** `true` for a server path below `/api`, which `access.routes` guards. */
  server: boolean
}

/** Source text of the ViteHub page meta for a module `auth` value, and what it drops. */
export function pageMeta(code: string, node: Node, style: CodeStyle): { meta?: string, user?: boolean, dropped: string[] } {
  const value = unwrapExpression(node)
  const literal = literalValue(value)
  if (literal === "user" || literal === true) return { meta: code.slice(start(value), end(value)), user: true, dropped: [] }
  if (literal === "guest" || literal === false) return { meta: code.slice(start(value), end(value)), user: false, dropped: [] }
  if (value.type !== "ObjectExpression") return { dropped: [] }
  const kept: string[] = []
  const dropped: string[] = []
  let only: string | undefined = "user"
  for (const property of value.properties) {
    const key = property.type === "ObjectProperty" ? keyName(property.key, property.computed) : undefined
    if (property.type !== "ObjectProperty" || (key !== "only" && key !== "redirectTo")) {
      dropped.push(key ?? code.slice(start(property), end(property)))
      continue
    }
    if (key === "only") {
      const mode = literalValue(property.value)
      if (mode !== "user" && mode !== "guest") return { dropped: [] }
      only = mode
    }
    kept.push(code.slice(start(property), end(property)))
  }
  const meta = kept.length === 1 && kept[0]?.startsWith("only") ? quoteString(only, style) : kept.length ? `{ ${kept.join(", ")} }` : quoteString("user", style)
  return { meta, user: only === "user", dropped }
}

/** The route path of a page file below `pages/`, such as `/app/:id` for `app/[id].vue`. */
export function pageRoute(relative: string): string {
  const segments = relative.replace(/\.vue$/, "").split("/").filter(segment => !/^\(.*\)$/.test(segment))
  if (segments.at(-1) === "index") segments.pop()
  return `/${segments.map(segment => segment.replace(/\[\.\.\.[^\]]*\]/, "**").replace(/\[\[?([^\]]+)\]?\]/g, ":$1")).join("/")}`
}

/** Specificity of `pattern` for `route`, or `undefined` when it does not match. Higher wins, as in Nitro route rules. */
function matchScore(pattern: string, route: string): number | undefined {
  if (pattern === route) return Number.MAX_SAFE_INTEGER
  const wildcard = /^(.*?)\/\*\*$/.exec(pattern)
  if (wildcard) {
    const base = wildcard[1] ?? ""
    if (/[*:]/.test(base)) return undefined
    return route === (base || "/") || route.startsWith(`${base}/`) ? base.length + 1 : undefined
  }
  const parts = pattern.split("/")
  const routeParts = route.split("/")
  if (parts.length !== routeParts.length) return undefined
  return parts.every((part, index) => part === "*" || part === routeParts[index]) ? pattern.length : undefined
}

/** The rule that applies to `route`: the most specific match. */
export function ruleFor(rules: readonly AuthRouteRule[], route: string): AuthRouteRule | undefined {
  let best: { rule: AuthRouteRule, score: number } | undefined
  for (const rule of rules) {
    const score = matchScore(rule.pattern, route)
    if (score !== undefined && (!best || score > best.score)) best = { rule, score }
  }
  return best?.rule
}

/** The `definePageMeta()` call of a script, if any. */
function pageMetaCall(program: ReturnType<typeof parseProgram>): CallExpression | undefined {
  let call: CallExpression | undefined
  walk(program, (node) => {
    if (!call && node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "definePageMeta") call = node
  })
  return call
}

export interface PageEdit {
  after?: string
  followUps: FollowUp[]
}

/**
 * Gives one page the guard of its route rule with `definePageMeta({ auth })`, and drops the module-only parts of an
 * `auth` page meta, such as `user` matching. A page that sets `auth` itself keeps it, as with the module.
 */
export function editPage(file: string, source: string, rule: AuthRouteRule | undefined, style: CodeStyle, typescript: boolean): PageEdit {
  const followUps: FollowUp[] = []
  const { descriptor } = parseSfc(source, { filename: file })
  const block = descriptor.scriptSetup
  const output = new MagicString(source)
  if (block && !block.src) {
    let program
    try {
      program = parseProgram(block.content, { typescript: block.lang === "ts" || block.lang === "tsx", jsx: block.lang === "tsx" || block.lang === "jsx" })
    }
    catch {
      return { followUps: [{ file, message: "The codemod could not parse <script setup>. Check the auth page meta of this page by hand." }] }
    }
    const offset = block.loc.start.offset
    const lineOffset = block.loc.start.line - 1
    const call = pageMetaCall(program)
    const [argument] = call?.arguments ?? []
    const object = argument && argument.type !== "SpreadElement" && argument.type !== "ArgumentPlaceholder" ? unwrapExpression(argument) : undefined
    if (call && object?.type !== "ObjectExpression") {
      followUps.push({ file, line: line(call) + lineOffset, message: "definePageMeta() has no object literal, so the codemod cannot read its auth. Check it by hand." })
      return { followUps }
    }
    const metaObject = object as ObjectExpression | undefined
    const auth: ObjectProperty | undefined = metaObject ? findProperty(metaObject, "auth") : undefined
    if (auth) {
      const { meta, dropped } = pageMeta(block.content, auth.value, style)
      if (!meta) followUps.push({ file, line: line(auth) + lineOffset, message: "This auth page meta is computed. ViteHub reads 'user', 'guest', true, false, or { only, redirectTo }. Check it by hand." })
      else if (dropped.length) {
        output.overwrite(offset + start(auth.value), offset + end(auth.value), meta)
        followUps.push({ file, line: line(auth) + lineOffset, message: `The ViteHub page guard reads only and redirectTo, so the codemod dropped ${dropped.join(", ")}. Check that rule in the page or in access.routes with authorize in server/auth.ts.` })
      }
      return { after: output.hasChanged() ? output.toString() : undefined, followUps }
    }
    if (!rule) return { followUps }
    const semicolon = style.semicolons ? ";" : ""
    if (metaObject && call) {
      const first = metaObject.properties[0]
      if (first) output.prependLeft(offset + start(first), `auth: ${rule.meta}, `)
      else output.overwrite(offset + start(metaObject), offset + end(metaObject), `{ auth: ${rule.meta} }`)
    }
    else {
      const lastImport = program.program.body.filter(statement => statement.type === "ImportDeclaration").at(-1)
      const text = `definePageMeta({ auth: ${rule.meta} })${semicolon}`
      if (lastImport) output.appendLeft(offset + end(lastImport), `\n\n${text}`)
      else output.appendLeft(offset, `\n${text}\n`)
    }
    return { after: output.toString(), followUps }
  }
  if (!rule) return { followUps }
  if (block?.src) return { followUps: [{ file, message: `<script setup> loads ${block.src}. Add definePageMeta({ auth: ${rule.meta} }) to this page by hand.` }] }
  const scriptLang = descriptor.script ? descriptor.script.lang : typescript ? "ts" : undefined
  const lang = scriptLang ? ` lang="${scriptLang}"` : ""
  output.prepend(`<script setup${lang}>\ndefinePageMeta({ auth: ${rule.meta} })\n</script>\n\n`)
  return { after: output.toString(), followUps }
}
