import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { glob } from "tinyglobby"

import type { FileEdit, FollowUp } from "../types.ts"

const callerPatterns = ["**/package.json", ".github/workflows/*.{yml,yaml}", "**/*.sh"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

interface Word { text: string, start: number }

function serverOptions(words: Word[]): Word[] {
  const [first, second, third] = words.map(word => word.text)
  const start = first === "vitehub" ? 1
    : (first === "pnpm" || first === "npx" || first === "bunx") && second === "vitehub" ? 2
      : ((first === "pnpm" || first === "npm") && second === "exec" || first === "yarn" && second === "exec") && third === "vitehub" ? 3
        : 0
  if (!start) return []
  const group = words[start]?.text
  const command = words[start + 1]?.text
  const agentDev = group === "agent" && command === "dev"
  const workspaceDev = group === "workspace" && command === "dev"
  if (!agentDev && !workspaceDev && ![
    "agent info", "agent invocations", "channels replay", "channels history", "channels sync",
    "connections list", "connections inspect", "connections connect", "connections disconnect", "connections set-key",
    "connections export", "connections import", "connections models", "connections activity",
    "connections approvals", "connections rotate-key", "connections revoke",
  ].includes(`${group} ${command}`)) return []
  const options: Word[] = []
  const args = words.slice(start + 2)
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const literal = word.text.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single)
    if (literal === "--" || (workspaceDev && literal === "exec") || (agentDev && literal.startsWith("!"))) break
    if (literal === "--url" || literal.startsWith("--url=")) return []
    if (/^--server(?:=|$)/.test(word.text)) options.push(word)
    if (["--server", "--agent", "--channel", "--timeout", "--path", "--trigger", "--cli", "--input", "--prompt", "-p", "--label", "--query", "--filter", "--cursor", "--limit", "--change", "--status", "--database"].includes(literal)) index++
  }
  return options
}

/** Scan simple shell commands without evaluating or rewriting shell data. */
function rewriteShell(input: string): string | undefined {
  const token = /[ \t\r]+|#[^\n]*|&&|\|\||[;|&\n]|(?:'[^']*'|"[^"$`\\]*"|[^\s"'`$\\;|&<>()])+/gy
  const options: Word[] = []
  let words: Word[] = []
  while (token.lastIndex < input.length) {
    const match = token.exec(input)
    if (!match) return undefined
    const text = match[0]
    if (text === "\n" || /^[;|&]/.test(text)) {
      options.push(...serverOptions(words))
      words = []
    }
    else if (!/^\s|^#/.test(text)) words.push({ start: match.index, text })
  }
  options.push(...serverOptions(words))
  let output = input
  for (const { start } of options.reverse()) output = `${output.slice(0, start)}--url${output.slice(start + "--server".length)}`
  return output
}

const possibleCall = /\bvitehub\b[\s\S]*?--server\b/

export async function rewriteCliCalls(cwd: string): Promise<{ edits: FileEdit[], followUps: FollowUp[] }> {
  const files = (await glob(callerPatterns, { cwd, dot: true, ignore: ignoredPatterns })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of files) {
    const before = await readFile(join(cwd, file), "utf8")
    if (!possibleCall.test(before)) continue
    const rewrite = (script: string): string => {
      const after = rewriteShell(script)
      if (after === undefined && possibleCall.test(script)) followUps.push({ file, message: "Check whether --server belongs to vitehub in this shell script and change it to --url if it does." })
      return after ?? script
    }
    let after = before
    if (file.endsWith("package.json")) {
      try {
        const manifest = JSON.parse(before)
        if (!manifest?.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) continue
        let changed = false
        for (const [name, script] of Object.entries(manifest.scripts)) {
          if (typeof script !== "string") continue
          const next = rewrite(script)
          if (next === script) continue
          changed = true
          manifest.scripts[name] = next
        }
        if (changed) after = `${JSON.stringify(manifest, null, /^([\t ]+)"/m.exec(before)?.[1] ?? 2)}${before.endsWith("\n") ? "\n" : ""}`
      }
      catch {
        followUps.push({ file, message: "Check this invalid package.json for vitehub --server calls." })
      }
    }
    else if (file.endsWith(".sh")) after = rewrite(before)
    else {
      // Only plain single-line `- run:` steps outside block scalars are unambiguous here.
      let blockIndent: number | undefined
      after = before.split("\n").map(line => {
        if (!line.trim()) return line
        const indent = /^ */.exec(line)![0].length
        if (blockIndent !== undefined && indent > blockIndent) return line
        blockIndent = /:\s*[|>][\d+-]*\s*(?:#.*)?$/.test(line) ? indent : undefined
        const step = /^( *- run:[ \t]+)([^"'|>\r\n][^\r\n]*)(\r?)$/.exec(line)
        return step ? step[1]! + rewrite(step[2]!) + step[3]! : line
      }).join("\n")
      if (possibleCall.test(after)) followUps.push({ file, message: "Check any remaining --server flags in workflow run steps; leave flags passed to other programs unchanged." })
    }
    if (after !== before) edits.push({ after, before, path: file })
  }
  return { edits, followUps }
}
