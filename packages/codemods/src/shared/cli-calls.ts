import { readFile } from "node:fs/promises"
import { join } from "node:path"

import MagicString from "magic-string"
import { glob } from "tinyglobby"
import { isMap, isScalar, isSeq, parseDocument } from "yaml"

import type { FileEdit, FollowUp } from "../types.ts"

const callerPatterns = ["**/package.json", ".github/workflows/*.{yml,yaml}", "**/*.sh"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

export interface ShellWord {
  text: string
  start: number
}

type Rewrite = (args: string, words: readonly ShellWord[]) => string | { message: string }

function rewriteShell(shell: string, rewrite: Rewrite, followUp: (message: string, offset: number) => void, changed: () => void): string {
  if (/\$\(|`|<<|\\\r?\n/.test(shell) || /\$\[|\$\{(?![A-Za-z_]\w*\})/.test(shell)) return shell
  const token = /[ \t\r]+|\n|#[^\n]*|&&|\|\||[;&|()<>]|(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[^\n]|[^\s'"\\;&|()<>])+/gy
  const edits = new MagicString(shell)
  const commands: ShellWord[][] = [[]]
  let redirected = false
  for (let offset = 0; offset < shell.length;) {
    const match = token.exec(shell)
    if (!match) return shell
    const [text] = match
    if (/^[()]$/.test(text)) return shell
    if (/^(?:\n|;|&&?|\|\|?)$/.test(text)) {
      commands.push([])
      redirected = false
    }
    else if (text === "<" || text === ">") redirected = true
    else if (!redirected && !/^(?:\s|#)/.test(text)) commands.at(-1)!.push({ start: offset, text })
    offset = token.lastIndex
  }
  if (commands.some(words => /^(?:case|for|select|function)$/.test(words[0]?.text ?? ""))) return shell
  for (const words of commands) {
    let index = 0
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[index]?.text ?? "")) index++
    if (["pnpm", "npm", "npx", "yarn", "bun", "bunx"].includes(words[index]?.text ?? "")) {
      const runner = words[index++]!.text
      if (["pnpm", "npm", "yarn", "bun"].includes(runner) && words[index]?.text === "exec") index++
      else if (runner === "npm") continue
    }
    if (words[index]?.text !== "vitehub" || !words[index + 1]) continue
    const args = words.slice(index + 1)
    const start = args[0]!.start
    const last = args.at(-1)!
    const end = last.start + last.text.length
    const before = shell.slice(start, end)
    const after = rewrite(before, args.map(word => ({ ...word, start: word.start - start })))
    if (typeof after !== "string") followUp(after.message, start)
    else if (after !== before) {
      edits.overwrite(start, end, after)
      changed()
    }
  }
  return edits.toString()
}

function supportedShell(shell: unknown): boolean {
  return typeof shell === "string" && /^(?:bash|sh)(?:\s|$)/.test(shell)
}

export async function rewriteCliCalls(cwd: string, rewrite: Rewrite): Promise<{ calls: number, edits: FileEdit[], followUps: FollowUp[] }> {
  const files = (await glob(callerPatterns, { cwd, dot: true, ignore: ignoredPatterns })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let calls = 0
  for (const file of files) {
    const before = await readFile(join(cwd, file), "utf8")
    const lineAt = (offset: number) => before.slice(0, offset).split("\n").length
    const rewriteScript = (shell: string, line: (offset: number) => number) => rewriteShell(shell, rewrite, (message, offset) => {
      followUps.push({ file, line: line(offset), message })
    }, () => { calls++ })
    let after: string
    if (file.endsWith(".sh")) after = rewriteScript(before, lineAt)
    else {
      const json = file.endsWith(".json")
      if (json) {
        try { JSON.parse(before) }
        catch { continue }
      }
      const document = parseDocument(before)
      if (document.errors.length) continue
      const output = new MagicString(before)
      const update = (node: unknown) => {
        if (!isScalar(node) || typeof node.value !== "string" || !node.range || node.anchor || node.tag) return
        const [start, end] = node.range
        const block = node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL"
        if (block && node.comment) return
        const next = rewriteScript(node.value, () => lineAt(start))
        if (next === node.value) return
        output.overwrite(start, end, `${JSON.stringify(next)}${before.slice(start, end).endsWith("\n") ? "\n" : ""}`)
      }
      if (json) {
        const scripts = document.get("scripts", true)
        if (isMap(scripts)) for (const script of scripts.items) update(script.value)
      }
      else {
        const jobs = document.get("jobs", true)
        if (isMap(jobs)) for (const { value: job } of jobs.items) {
          if (!isMap(job)) continue
          const steps = job.get("steps", true)
          if (!isSeq(steps)) continue
          for (const step of steps.items) {
            if (!isMap(step) || step.has("uses")) continue
            const shell = step.get("shell") ?? job.getIn(["defaults", "run", "shell"]) ?? document.getIn(["defaults", "run", "shell"])
            const runner = job.get("runs-on")
            if (shell !== undefined ? !supportedShell(shell) : typeof runner !== "string" || !/^(?:ubuntu|macos)-/.test(runner)) continue
            update(step.get("run", true))
          }
        }
      }
      after = output.toString()
    }
    if (after !== before) edits.push({ after, before, path: file })
  }
  return { calls, edits, followUps }
}
