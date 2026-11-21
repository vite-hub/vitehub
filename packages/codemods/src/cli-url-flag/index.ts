import { findCliCalls, rewriteCliCalls } from "../shared/cli-calls.ts"

import type { CliCall } from "../shared/cli-calls.ts"
import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

function serverOptions({ words }: CliCall) {
  const [group, action, ...args] = words
  const name = `${group?.text} ${action?.text}`
  if (!["agent dev", "workspace dev", "agent info", "agent invocations", "channels replay", "channels history", "channels sync",
    "connections list", "connections inspect", "connections connect", "connections disconnect", "connections set-key",
    "connections export", "connections import", "connections models", "connections activity",
    "connections approvals", "connections rotate-key", "connections revoke",
  ].includes(name)) return { offsets: [], hasUrl: false }
  const offsets: number[] = []
  let hasUrl = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const literal = word.text.replace(/^(['"])(.*)\1$/, "$2")
    if (literal === "--" || (name === "workspace dev" && literal === "exec") || (name === "agent dev" && literal.startsWith("!"))) break
    if (/^--url(?:=|$)/.test(literal)) hasUrl = true
    if (/^--server(?:=|$)/.test(word.text)) offsets.push(word.start)
    if (["--url", "--server", "--agent", "--channel", "--timeout", "--path", "--trigger", "--cli", "--input", "--prompt", "-p", "--label", "--query", "--filter", "--cursor", "--limit", "--change", "--status", "--database", "--cookie", "--confirm"].includes(literal)) index++
  }
  return { offsets, hasUrl }
}

function rewrite(call: CliCall): string {
  const { offsets, hasUrl } = serverOptions(call)
  if (hasUrl) return call.command
  let command = call.command
  for (const start of offsets.reverse()) command = `${command.slice(0, start)}--url${command.slice(start + "--server".length)}`
  return command
}

function manual(command: string): string | undefined {
  const calls = findCliCalls(command, true)
  const candidate = calls
    ? calls.some(({ call }) => serverOptions(call).offsets.length)
    : /^\s*(?:(?:pnpm|npm|yarn) exec |(?:pnpm|npx|bunx) )?vitehub (?:agent|workspace|channels|connections)\b.*--server\b/.test(command)
  if (candidate) return "Check whether --server belongs to vitehub in this command and change it to --url if it does."
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { edits, followUps } = await rewriteCliCalls(cwd, rewrite, manual)
  return {
    summary: edits.length ? `moved vitehub calls from --server to --url in ${edits.length} file(s)` : "no vitehub calls migrated",
    edits,
    followUps,
    notes: edits.length ? ["`--server` is now `--url`, the app URL. A `--url` that names the Console (a `/_vitehub` path) now fails: pass the app URL without `/_vitehub`."] : [],
    nextSteps: [],
  }
}

export const cliUrlFlag: Codemod = {
  name: "cli-url-flag",
  description: "Use --url, the app URL, in vitehub calls of scripts and CI instead of --server",
  usage: "[dir]",
  async detect({ cwd }) {
    const { edits, followUps } = await migrate({ cwd })
    const file = edits[0]?.path ?? followUps[0]?.file
    return file ? { reason: `${file} may pass --server to vitehub` } : undefined
  },
  run: migrate,
}
