import { end, start, walk } from "@vite-hub/internal/ast"

import { defineFunctionNames, followUpAt } from "./shared.ts"

import type MagicString from "magic-string"
import type { Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"
import type { ParsedFile, SourceFile } from "./shared.ts"

const scheduleModules: ReadonlySet<string> = new Set(["vite-hub/schedule", "@vite-hub/schedule"])

/** The text of a property: `cron` for `cron: cron`, else `cron: <value>`. */
function property(key: string, value: string): string {
  return value === key ? key : `${key}: ${value}`
}

/**
 * Rewrites `defineSchedule(cron, handler, options)` to `defineSchedule({ cron, ...options, handler })`. Literal options
 * move into the object. Other options become a spread and a follow-up, because the build reads `manual` from literal
 * options.
 */
export function rewriteSchedules(file: SourceFile, parsed: ParsedFile, output: MagicString, followUps: FollowUp[]): number {
  if (!file.code.includes("defineSchedule")) return 0
  const names = defineFunctionNames(parsed.program, "defineSchedule", scheduleModules)
  const text = (node: Node) => file.code.slice(start(node), end(node))
  let count = 0
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !names.has(node.callee.name)) return
    const [cron, handler, options, ...rest] = node.arguments
    if (!cron || !handler || cron.type === "ObjectExpression") return
    if (cron.type === "SpreadElement" || handler.type === "SpreadElement" || options?.type === "SpreadElement" || rest.length) {
      followUps.push(followUpAt(file.path, node, "`defineSchedule(cron, handler)` was removed. Rewrite this call as `defineSchedule({ cron, handler })` by hand."))
      return
    }
    const fields = [property("cron", text(cron))]
    if (options?.type === "ObjectExpression") {
      fields.push(...options.properties.map(text))
    }
    else if (options) {
      fields.push(`...${text(options)}`)
      followUps.push(followUpAt(file.path, node, "The options of this Schedule are not an object literal, so the codemod spread them. The build reads `manual` and `timeZone` only from literal properties: write them in the object."))
    }
    fields.push(property("handler", text(handler)))
    output.overwrite(start(cron), end(options ?? handler), `{ ${fields.join(", ")} }`)
    count++
  })
  return count
}
