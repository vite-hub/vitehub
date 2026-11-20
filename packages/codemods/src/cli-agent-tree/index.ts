import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"
import type { ShellWord } from "../shared/cli-calls.ts"

/** One `vitehub agent` tree. Each entry rewrites the start of the arguments after `vitehub `. */
const renames: ReadonlyArray<[RegExp, string]> = [
  [/^agents\s+(list|invoke)(?=\s|$)/, "agent $1"],
  [/^invocations\s+(cancel|undo|capabilities|workspace)(?=\s|$)/, "agent invocations $1"],
  [/^conversations\s+export(?=\s|$)/, "agent conversations export"],
]

const inspectionFollowUp = { message: "Move --agent to the name in `vitehub agent get <name>`. For old `agents status` calls, pass the Console app's --url; for Dev Loop calls with a URL, use --dev --url." }

function unquote(word: string) {
  return word.replace(/^(['"])(.*)\1$/, "$2")
}

function hasOption(words: readonly string[], flag: string) {
  return words.some(word => unquote(word) === flag || unquote(word).startsWith(`${flag}=`))
}

function rewriteInspection(options: readonly string[], status: boolean) {
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
    if (flag !== "--agent" && flag !== "--url") return inspectionFollowUp
    const separate = option === flag
    const value = separate ? options[++index] : option.slice(flag.length + 1)
    if (!value || unquote(value).startsWith("-")) return inspectionFollowUp
    if (flag === "--agent") {
      if (name || !/^[\w.][\w.-]*$/.test(unquote(value))) return inspectionFollowUp
      name = value
    }
    else {
      if (url) return inspectionFollowUp
      url = true
      if (separate) tail.push("--url", value)
      else tail.push(`--url=${value}`)
    }
  }
  if (!name || (status && !url)) return inspectionFollowUp
  return ["agent get", name, ...(dev || (!status && url) ? ["--dev"] : []), ...tail].join(" ")
}

function rewrite(args: string, words: readonly ShellWord[]): string | { message: string } {
  const [namespace, command, ...options] = words.map(word => word.text)
  if (namespace === "agents" && command === "status") return rewriteInspection(options, true)
  if (namespace === "agent" && command === "get" && hasOption(options, "--agent")) return rewriteInspection(options, false)
  if (namespace === "invocations" && command === "delete") {
    return { message: "Select the same Console app explicitly with `vitehub agent invocations delete <id> --url <app>`; without --url the new command deletes from the journal file. Add --yes for a noninteractive script." }
  }
  if (namespace === "invocations" && (command === "list" || command === "get")) {
    return { message: "Review this Console Invocation read before moving it under `vitehub agent invocations`: list no longer exposes the Console cursor and get returns a flat record rather than the Console detail envelope. Check supported filters and observation options with --help, or keep using the invocations.list/get Console RPC when you need the old inputs or response." }
  }
  if (namespace === "invocations" && command && ["cancel", "undo", "capabilities", "workspace"].includes(command) && hasOption(options, "--input")) {
    return { message: "Move this Invocation operation under `vitehub agent invocations` by hand: replace --input with the positional ID and supported options, or call the Console RPC directly." }
  }
  if (namespace === "invocations" && (command === "cancel" || command === "undo") && !hasOption(options, "--url")) {
    return { message: "Move this Invocation operation under `vitehub agent invocations` by hand and pass --url with the same Console app." }
  }
  for (const [pattern, now] of renames) if (pattern.test(args)) return args.replace(pattern, now)
  return args
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits, followUps } = await rewriteCliCalls(cwd, rewrite)
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
