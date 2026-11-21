import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { CliCall } from "../shared/cli-calls.ts"
import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

function literal(text: string | undefined) {
  return text?.replace(/^(['"])(.*)\1$/, "$2")
}

function onlyRevokeOptions(options: string[]): boolean {
  for (let index = 0; index < options.length; index++) {
    const option = options[index]
    if (option === "--json") continue
    if (option === "--url" || option === "--cookie") {
      const value = literal(options[++index])
      if (!value || value.startsWith("-")) return false
    }
    else if (!option || !/^--(?:url|cookie)=.+$/.test(option)) return false
  }
  return true
}

/** `--yes` is the one flag that skips a question. */
function rewrite({ command, words, posix }: CliCall): string {
  const [namespace, action, ...args] = words
  const replace = (start: number, end: number, value: string) => command.slice(0, start) + value + command.slice(end)
  if (namespace?.text === "database" && (action?.text === "drop" || action?.text === "reset")) {
    const flags = args.filter(word => word.text === "--force")
    if (flags.length === 1 && flags[0] && !args.some(word => literal(word.text) === "--")) {
      return replace(flags[0].start, flags[0].end, "--yes")
    }
  }
  if (namespace?.text === "database" && action?.text === "generate" && posix) {
    const flags = args.filter(word => word.text === "--non-interactive")
    if (flags.length === 1 && flags[0] && !args.some(word => literal(word.text) === "--")) {
      return `CI=1 ${command.slice(0, flags[0].start).trimEnd()}${command.slice(flags[0].end)}`
    }
  }
  if (namespace?.text === "connections" && action?.text === "revoke") {
    const [target, confirmation, value] = args
    const name = literal(target?.text)
    if (!name || !/^[\w][\w.-]*$/.test(name) || !confirmation) return command
    const inline = confirmation.text.startsWith("--confirm=")
    const end = inline ? confirmation.end : value?.end
    if (end === undefined || (!inline && confirmation.text !== "--confirm")) return command
    const confirmedName = literal(inline ? confirmation.text.slice("--confirm=".length) : value?.text)
    if (name === confirmedName && onlyRevokeOptions(args.slice(inline ? 2 : 3).map(word => word.text))) {
      return replace(confirmation.start, end, "--yes")
    }
  }
  return command
}

function manual(command: string): string | undefined {
  if (/\bvitehub\s+connections\s+revoke\b.*--confirm\b/.test(command)) return "Replace the old confirmation with --yes only after checking that it and the target name the same Connection."
  if (/\bvitehub\s+database\s+generate\b.*--non-interactive\b/.test(command)) return "Set CI=1 in the command's environment before removing --non-interactive so generation still cannot prompt."
  if (/\bvitehub\s+database\s+(?:drop|reset)\b.*--force\b/.test(command)) return "Change --force to --yes if it is a flag of database drop or reset."
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits, followUps } = await rewriteCliCalls(cwd, rewrite, manual)
  return {
    summary: calls || followUps.length ? `updated ${calls} vitehub call(s); ${followUps.length} need manual review` : "found no vitehub call that skips a question with another flag",
    edits,
    followUps,
    notes: [],
    nextSteps: [],
  }
}

export const cliYesFlag: Codemod = {
  name: "cli-yes-flag",
  description: "Use --yes in vitehub calls of scripts and CI: database drop|reset --force, connections revoke --confirm, database generate --non-interactive",
  usage: "[dir]",
  async detect({ cwd }) {
    const { edits, followUps } = await migrate({ cwd })
    const file = edits[0]?.path ?? followUps[0]?.file
    return file ? { reason: `${file} may use a removed vitehub prompt flag` } : undefined
  },
  run: migrate,
}
