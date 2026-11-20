import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { CliCall } from "../shared/cli-calls.ts"
import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

/** One `vitehub agent` tree: the old namespace and command, and the words that replace them. */
const renames: ReadonlyArray<[string, readonly string[], string]> = [
  ["agents", ["list", "invoke"], "agent"],
  ["invocations", ["cancel", "undo", "capabilities", "workspace"], "agent invocations"],
  ["conversations", ["export"], "agent conversations"],
]

const inspectionFollowUp = "Move --agent to the name in `vitehub agent get <name>`. For old `agents status` calls, pass the Console app's --url; for Dev Loop calls with a URL, use --dev --url."

function unquote(word: string) {
  return word.replace(/^(['"])(.*)\1$/, "$2")
}

function hasOption(words: readonly string[], flag: string) {
  return words.some(word => unquote(word) === flag || unquote(word).startsWith(`${flag}=`))
}

function rewriteInspection(options: readonly string[], status: boolean): string | undefined {
  let name: string | undefined
  let url = false
  let dev = false
  const tail: string[] = []
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (!status && option === "--dev") {
      dev = true
      continue
    }
    if (["--json", "--help", "-h"].includes(option)) {
      tail.push(option)
      continue
    }
    const flag = option.split("=", 1)[0]
    if (flag !== "--agent" && flag !== "--url") return undefined
    const separate = option === flag
    const value = separate ? options[++index] : option.slice(flag.length + 1)
    if (!value || unquote(value).startsWith("-")) return undefined
    if (flag === "--agent") {
      if (name || !/^[\w.][\w.-]*$/.test(unquote(value))) return undefined
      name = value
    }
    else {
      if (url) return undefined
      url = true
      if (separate) tail.push("--url", value)
      else tail.push(`--url=${value}`)
    }
  }
  if (!name || (status && !url)) return undefined
  return ["agent get", name, ...(dev || (!status && url) ? ["--dev"] : []), ...tail].join(" ")
}

function rewrite({ command, words }: CliCall): string {
  const [namespace, action, ...rest] = words
  if (!namespace || !action) return command
  const options = rest.map(word => word.text)
  const prefix = command.slice(0, namespace.start)
  const inspection = (namespace.text === "agents" && action.text === "status") ? rewriteInspection(options, true)
    : (namespace.text === "agent" && action.text === "get" && hasOption(options, "--agent")) ? rewriteInspection(options, false)
      : undefined
  if (inspection) return `${prefix}${inspection}`
  if (namespace.text === "invocations" && (hasOption(options, "--input") || ((action.text === "cancel" || action.text === "undo") && !hasOption(options, "--url")))) return command
  for (const [from, actions, to] of renames) {
    if (namespace.text === from && actions.includes(action.text)) return `${prefix}${to} ${command.slice(action.start)}`
  }
  return command
}

/** Agent calls that the codemod leaves for a person, with what to do. */
function manual(line: string): string | undefined {
  if (/\bvitehub\s+(?:agents\s+status\b|agent\s+get\b.*--agent\b)/.test(line)) return inspectionFollowUp
  if (/\bvitehub\s+invocations\s+delete\b/.test(line)) return "Select the same Console app explicitly with `vitehub agent invocations delete <id> --url <app>`; without --url the new command deletes from the journal file. Add --yes for a noninteractive script."
  if (/\bvitehub\s+invocations\s+(?:list|get)\b/.test(line)) return "Review this Console Invocation read before moving it under `vitehub agent invocations`: list no longer exposes the Console cursor and get returns a flat record rather than the Console detail envelope. Check supported filters and observation options with --help, or keep using the invocations.list/get Console RPC when you need the old inputs or response."
  if (/\bvitehub\s+invocations\s+(?:cancel|undo|capabilities|workspace)\b.*--input\b/.test(line)) return "Move this Invocation operation under `vitehub agent invocations` by hand: replace --input with the positional ID and supported options, or call the Console RPC directly."
  if (/\bvitehub\s+invocations\s+(?:cancel|undo)\b/.test(line)) return "Move this Invocation operation under `vitehub agent invocations` by hand and pass --url with the same Console app."
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits, followUps } = await rewriteCliCalls(cwd, rewrite, manual)
  const summary = edits.length ? `moved ${calls} vitehub call(s) into the vitehub agent commands` : followUps.length ? "found Agent commands that need manual migration" : "found no vitehub agents, invocations, or conversations call"
  return {
    summary,
    edits,
    followUps,
    notes: [],
    nextSteps: [],
  }
}

export const cliAgentTree: Codemod = {
  name: "cli-agent-tree",
  description: "Move vitehub agents, invocations, and conversations calls of scripts and CI into the vitehub agent commands",
  usage: "[dir]",
  async detect({ cwd }) {
    const { edits, followUps } = await migrate({ cwd })
    const file = edits[0]?.path ?? followUps[0]?.file
    return file ? { reason: `${file} calls a vitehub Agent command that moved` } : undefined
  },
  run: migrate,
}
