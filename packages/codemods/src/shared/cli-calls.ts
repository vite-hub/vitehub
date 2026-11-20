import { readFile } from "node:fs/promises"
import { join } from "node:path"

import MagicString from "magic-string"
import { glob } from "tinyglobby"
import { isMap, isScalar, isSeq, parseDocument } from "yaml"

import type { FileEdit, FollowUp } from "../types.ts"

/** Files that call the `vitehub` CLI: package scripts, CI workflows, and shell scripts. */
const callerPatterns = ["**/package.json", ".github/workflows/*.{yml,yaml}", "**/*.sh"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

interface Word {
  text: string
  start: number
  end: number
}

export interface CliCall {
  command: string
  words: Word[]
  posix: boolean
}

type Rewrite = (call: CliCall) => string

/** Recognizes only simple commands with literal shell words. */
function commands(source: string, posix: boolean): Word[][] | undefined {
  const token = /[ \t]+|\r?\n|&&|\|\||;|#[^\r\n]*|[\w./:@=+,-]*"[\w ./:'@=+,-]*"|[\w./:@=+,-]*'[\w ./:"@=+,-]*'|[\w./:@=+,-]+/gy
  const result: Word[][] = []
  let words: Word[] = []
  let offset = 0
  while (offset < source.length) {
    const match = token.exec(source)
    if (!match) return
    const text = match[0]
    if (/^(?:\r?\n|&&|\|\||;)$/.test(text)) {
      if (!posix && (text === ";" || text.endsWith("\n"))) return
      result.push(words)
      words = []
    }
    else if (!/^[ \t]/.test(text)) {
      if (words.at(-1)?.end === offset || (!posix && (text.startsWith("#") || text.includes("'")))) return
      if (!text.startsWith("#")) words.push({ text, start: offset, end: token.lastIndex })
    }
    offset = token.lastIndex
  }
  result.push(words)
  return result
}

function rewriteShell(source: string, posix: boolean, rewrite: Rewrite): string {
  const parsed = commands(source, posix)
  if (!parsed) return source
  let after = ""
  let offset = 0
  for (const words of parsed) {
    const cli = ["pnpm", "npx"].includes(words[0]?.text ?? "") ? 1 : 0
    const start = words[0]?.start
    const end = words.at(-1)?.end
    if (start === undefined || end === undefined || words[cli]?.text !== "vitehub") continue
    after += source.slice(offset, start) + rewrite({ command: source.slice(start, end), words: words.slice(cli + 1).map(word => ({ ...word, start: word.start - start, end: word.end - start })), posix })
    offset = end
  }
  return after + source.slice(offset)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rewriteWorkflow(source: string, transform: (command: string) => string, report: (command: string) => void): string {
  const document = parseDocument(source)
  if (document.errors.length) {
    report(source)
    return source
  }
  const jobs = document.get("jobs", true)
  if (!isMap(jobs)) return source
  const edited = new MagicString(source)
  for (const { value: job } of jobs.items) {
    if (!isMap(job)) continue
    const steps = job.get("steps", true)
    if (!isSeq(steps)) continue
    for (const step of steps.items) {
      if (!isMap(step)) continue
      const run = step.get("run", true)
      if (!isScalar(run) || typeof run.value !== "string") continue
      const range = run.range
      let command = run.value
      if (range && run.type === "PLAIN" && !run.anchor && !command.includes("\n") && source.slice(range[0], range[1]) === command) {
        const next = transform(command)
        if (next !== command) edited.update(range[0], range[1], next)
        command = next
      }
      report(command)
    }
  }
  return edited.toString()
}

export async function rewriteCliCalls(cwd: string, rewrite: Rewrite, manual: (command: string) => string | undefined) {
  const files = (await glob(callerPatterns, { cwd, dot: true, ignore: ignoredPatterns })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let calls = 0
  for (const file of files) {
    const before = await readFile(join(cwd, file), "utf8")
    const transform = (source: string, posix: boolean) => rewriteShell(source, posix, (call) => {
      const next = rewrite(call)
      if (next !== call.command) calls++
      return next
    })
    const report = (source: string, label = "") => {
      for (const line of source.replace(/\\\r?\n/g, "").split("\n")) {
        if (line.trimStart().startsWith("#")) continue
        const message = manual(line)
        if (message) followUps.push({ file, message: label + message })
      }
    }
    let after = before
    if (file.endsWith("package.json")) {
      let manifest: unknown
      try { manifest = JSON.parse(before) }
      catch {
        report(before)
        continue
      }
      if (!isRecord(manifest) || !isRecord(manifest.scripts)) continue
      let changed = false
      for (const [name, script] of Object.entries(manifest.scripts)) {
        if (typeof script !== "string") continue
        const next = transform(script, false)
        report(next, `Script ${name}: `)
        if (next === script) continue
        changed = true
        manifest.scripts[name] = next
      }
      if (changed) {
        const indent = /^[ \t]+(?=")/m.exec(before)?.[0]
        after = JSON.stringify(manifest, null, indent) + (before.endsWith("\n") ? "\n" : "")
      }
    }
    else if (file.endsWith(".sh")) {
      after = transform(before, true)
      report(after)
    }
    else {
      after = rewriteWorkflow(before, command => transform(command, false), report)
    }
    if (after !== before) edits.push({ after, before, path: file })
  }
  return { calls, edits, followUps }
}
