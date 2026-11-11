import { end, keyName, start, walk } from "@vite-hub/internal/ast"

import { defineFunctionNames, followUpAt } from "./shared.ts"

import type MagicString from "magic-string"
import type { FollowUp } from "../types.ts"
import type { ParsedFile, SourceFile } from "./shared.ts"

const sandboxTaskModules: ReadonlySet<string> = new Set(["vite-hub/sandbox/task", "@vite-hub/sandbox/task"])

/** Renames the `run` option of `defineSandboxTask()` to `handler`. */
export function rewriteSandboxTasks(file: SourceFile, parsed: ParsedFile, output: MagicString, followUps: FollowUp[]): number {
  if (!file.code.includes("defineSandboxTask")) return 0
  const names = defineFunctionNames(parsed.program, "defineSandboxTask", sandboxTaskModules)
  let count = 0
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !names.has(node.callee.name)) return
    const [options] = node.arguments
    if (options?.type !== "ObjectExpression") {
      followUps.push(followUpAt(file.path, node, "The options of this Sandbox Task are not an object literal. Rename its `run` option to `handler` by hand."))
      return
    }
    const keyed = (name: string) => options.properties.find(item => item.type !== "SpreadElement" && keyName(item.key, item.computed) === name)
    const run = keyed("run")
    if (!run || run.type === "SpreadElement") {
      if (options.properties.some(item => item.type === "SpreadElement") && !keyed("handler")) {
        followUps.push(followUpAt(file.path, node, "The options of this Sandbox Task use a spread. Check that it passes `handler`, not `run`."))
      }
      return
    }
    if (keyed("handler")) {
      followUps.push(followUpAt(file.path, run, "This Sandbox Task sets both `run` and `handler`. Keep one `handler`."))
      return
    }
    if (run.type === "ObjectProperty" && run.shorthand) output.overwrite(start(run), end(run), "handler: run")
    else output.overwrite(start(run.key), end(run.key), "handler")
    count++
  })
  return count
}
