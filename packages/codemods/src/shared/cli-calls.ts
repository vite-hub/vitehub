import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { glob } from "tinyglobby"

import type { FileEdit } from "../types.ts"

/** Files that call the `vitehub` CLI: package scripts, CI workflows, and shell scripts. */
const callerPatterns = ["**/package.json", ".github/workflows/*.{yml,yaml}", "**/*.sh"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

/**
 * One `vitehub` call: the text after `vitehub ` up to the end of that shell command, such as
 * `database drop --force` in `pnpm vitehub database drop --force && pnpm dev`.
 */
const call = /\bvitehub[ \t]+([^\n"'`&;|)]*)/g

/**
 * Rewrites the arguments of each `vitehub` call in the files that call the CLI. `rewrite` gets the text after
 * `vitehub ` and returns the new text, or the same text when the call does not change.
 */
export async function rewriteCliCalls(cwd: string, rewrite: (args: string) => string): Promise<{ calls: number, edits: FileEdit[] }> {
  const files = (await glob(callerPatterns, { cwd, dot: true, ignore: ignoredPatterns })).sort()
  const edits: FileEdit[] = []
  let calls = 0
  for (const file of files) {
    const before = await readFile(join(cwd, file), "utf8")
    const after = before.replace(call, (whole, args: string) => {
      const next = rewrite(args)
      if (next === args) return whole
      calls++
      return `${whole.slice(0, whole.length - args.length)}${next}`
    })
    if (after !== before) edits.push({ after, before, path: file })
  }
  return { calls, edits }
}
