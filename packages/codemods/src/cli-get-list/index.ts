import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

/** `get` reads one record and `list` reads many. Each entry rewrites the start of the arguments after `vitehub `. */
const renames: ReadonlyArray<[RegExp, string]> = [
  [/^agent\s+info\b/, "agent get"],
  [/^agent\s+invocations\s+show\b/, "agent invocations get"],
  [/^content\s+show\b/, "content get"],
  [/^email\s+outbox\s+show\b/, "email outbox get"],
  [/^queue\s+jobs\s+show\b/, "queue jobs get"],
  [/^workspace\s+show\b/, "workspace get"],
  [/^workflow\s+runs\s+show\b/, "workflow runs get"],
  [/^workflow\s+get\b/, "workflow runs get"],
  [/^schedule\s+attempts\b/, "schedule runs get"],
  [/^schedule\s+runs\s+(?!list\b|get\b|-)/, "schedule runs list "],
  [/^env\s+inspect\b/, "env list"],
  [/^env\s+status\b/, "env list"],
  [/^project\s+info\b/, "project get"],
  [/^definitions\s+list\b/, "inspect definitions"],
]

function rewrite(args: string): string {
  for (const [pattern, now] of renames) if (pattern.test(args)) return args.replace(pattern, now)
  return args
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits } = await rewriteCliCalls(cwd, rewrite)
  return {
    summary: edits.length ? `renamed ${calls} vitehub call(s) to get and list` : "found no vitehub call with a renamed read command",
    edits,
    followUps: [],
    notes: calls ? ["`get` reads one record and `list` reads many. `vitehub env status` is now `vitehub env list --url <app>`: a call without `--url` now reads the local stage, so add `--url` where the script asks a deployment."] : [],
    nextSteps: [],
  }
}

export const cliGetList: Codemod = {
  name: "cli-get-list",
  description: "Rename vitehub read commands in scripts and CI: show and info to get, env inspect and env status to env list, schedule runs to runs list, and more",
  usage: "[dir]",
  async detect({ cwd }) {
    const [edit] = (await migrate({ cwd })).edits
    return edit ? { reason: `${edit.path} calls a renamed vitehub read command` } : undefined
  },
  run: migrate,
}
