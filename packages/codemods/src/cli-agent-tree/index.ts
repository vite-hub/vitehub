import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

/** One `vitehub agent` tree. Each entry rewrites the start of the arguments after `vitehub `. */
const renames: ReadonlyArray<[RegExp, string]> = [
  [/^agents\s+status\s+--agent(?:=|\s+)/, "agent get "],
  [/^agents\s+status\b/, "agent get"],
  [/^agents\s+(list|invoke)\b/, "agent $1"],
  [/^invocations\s+(list|get|cancel|undo|delete|capabilities|workspace)\b/, "agent invocations $1"],
  [/^conversations\s+export\b/, "agent conversations export"],
  [/^agent\s+get\s+--agent(?:=|\s+)/, "agent get "],
]

function rewrite(args: string): string {
  for (const [pattern, now] of renames) if (pattern.test(args)) return args.replace(pattern, now)
  return args
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits } = await rewriteCliCalls(cwd, rewrite)
  return {
    summary: edits.length ? `moved ${calls} vitehub call(s) into the vitehub agent commands` : "found no vitehub agents, invocations, or conversations call",
    edits,
    followUps: [],
    notes: calls ? ["`vitehub agents …`, `vitehub invocations …`, and `vitehub conversations export` are now under `vitehub agent`. `vitehub agent invocations delete <id> --url <app>` asks first: add `--yes` in a script."] : [],
    nextSteps: [],
  }
}

export const cliAgentTree: Codemod = {
  name: "cli-agent-tree",
  description: "Move vitehub agents, invocations, and conversations calls of scripts and CI into the vitehub agent commands",
  usage: "[dir]",
  async detect({ cwd }) {
    const [edit] = (await migrate({ cwd })).edits
    return edit ? { reason: `${edit.path} calls a vitehub Agent command that moved` } : undefined
  },
  run: migrate,
}
