import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult, FollowUp } from "../types.ts"

/** One `vitehub agent` tree. Each entry rewrites the start of the arguments after `vitehub `. */
const renames: ReadonlyArray<[RegExp, string]> = [
  [/^agents\s+(list|invoke)\b/, "agent $1"],
  [/^invocations\s+(cancel|undo|capabilities|workspace)\b/, "agent invocations $1"],
  [/^conversations\s+export\b/, "agent conversations export"],
]

const agentStatus = /^agents\s+status(?=\s|$)/
const agentGet = /^agent\s+get(?=\s|$)/
const agentOption = /(?:^|\s)--agent(?=\s|=|$)/
const appUrlOption = /(?:^|\s)--url(?:=|\s+)[^\s-]\S*/

function rewrite(args: string, cutByQuote: boolean, followUp: (message: string) => string): string {
  const inspect = agentStatus.exec(args) ?? agentGet.exec(args)
  if (inspect) {
    const tail = args.slice(inspect[0].length)
    const status = agentStatus.test(args)
    if (status || agentOption.test(tail)) {
      const selector = /\s+--agent(?:=|\s+)([\w.][\w.-]*)(?=\s|$)/.exec(tail)
      if (!selector || cutByQuote || tail.includes("\\") || agentOption.test(tail.replace(selector[0], "")) || /(?:^|\s)--input(?=\s|=|$)/.test(tail) || (status && !appUrlOption.test(tail))) {
        return followUp("Move --agent to the name in `vitehub agent get <name>`. For old `agents status` calls, pass the Console app's --url; for Dev Loop calls with a URL, use --server.")
      }
      const options = tail.replace(selector[0], "")
      return `agent get ${selector[1]}${status ? options : options.replace(/(\s)--url(?=\s|=|$)/, "$1--server")}`
    }
    if (/^\s+-/.test(tail) && /(?:^|\s)--url(?=\s|=|$)/.test(tail)) {
      return followUp("Check `vitehub agent get` by hand: use a positional Agent name and --server for an explicit Dev Loop URL.")
    }
  }
  if (/^invocations\s+delete(?=\s|$)/.test(args)) {
    return followUp("Select the same Console app explicitly with `vitehub agent invocations delete <id> --url <app>`; without --url the new command deletes from the journal file. Add --yes for a noninteractive script.")
  }
  if (/^invocations\s+(list|get)(?=\s|$)/.test(args)) {
    return followUp("Review this Console Invocation read before moving it under `vitehub agent invocations`: list no longer exposes the Console cursor and get returns a flat record rather than the Console detail envelope. Check supported filters and observation options with --help, or keep using the invocations.list/get Console RPC when you need the old inputs or response.")
  }
  if (/^invocations\s+(cancel|undo|capabilities|workspace)(?=\s|$)/.test(args) && /(?:^|\s)--input(?=\s|=|$)/.test(args)) {
    return followUp("Move this Invocation operation under `vitehub agent invocations` by hand: replace --input with the positional ID and supported options, or call the Console RPC directly.")
  }
  if (/^invocations\s+(cancel|undo)(?=\s|$)/.test(args) && !appUrlOption.test(args)) {
    return followUp("Move this Invocation operation under `vitehub agent invocations` by hand and pass --url with the same Console app.")
  }
  for (const [pattern, now] of renames) if (pattern.test(args)) return args.replace(pattern, now)
  return args
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const followUps: FollowUp[] = []
  const { calls, edits } = await rewriteCliCalls(cwd, (args, file, nextChar) => {
    const cutByQuote = nextChar !== undefined && "\"'`".includes(nextChar) && !(nextChar === '"' && file.endsWith("package.json"))
    return rewrite(args, cutByQuote, (message) => {
      if (!followUps.some(item => item.file === file && item.message === message)) followUps.push({ file, message })
      return args
    })
  })
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
