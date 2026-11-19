import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

/** `--yes` is the one flag that skips a question. */
function rewrite(args: string): string {
  if (/^database\s+(?:drop|reset)\b/.test(args)) return args.replace(/(\s)--force\b/g, "$1--yes")
  if (/^database\s+generate\b/.test(args)) return args.replace(/\s+--non-interactive\b/g, "")
  if (/^connections\s+revoke\b/.test(args)) return args.replace(/(\s)--confirm(?:=|\s+)\S+/g, "$1--yes")
  return args
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits } = await rewriteCliCalls(cwd, rewrite)
  return {
    summary: edits.length ? `moved ${calls} vitehub call(s) to --yes` : "found no vitehub call that skips a question with another flag",
    edits,
    followUps: [],
    notes: calls ? ["`database drop|reset --force` and `connections revoke --confirm <name>` are now `--yes`. `database generate` lost `--non-interactive`: without a terminal, or with CI set, it never asks."] : [],
    nextSteps: [],
  }
}

export const cliYesFlag: Codemod = {
  name: "cli-yes-flag",
  description: "Use --yes in vitehub calls of scripts and CI: database drop|reset --force, connections revoke --confirm, database generate --non-interactive",
  usage: "[dir]",
  async detect({ cwd }) {
    const [edit] = (await migrate({ cwd })).edits
    return edit ? { reason: `${edit.path} skips a vitehub question without --yes` } : undefined
  },
  run: migrate,
}
