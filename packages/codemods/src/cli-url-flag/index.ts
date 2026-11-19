import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

/** `--url` is the app in every `vitehub` command, so `--server <url>` is `--url <url>`. */
function rewrite(args: string): string {
  return args.replace(/(\s)--server(=|\s)/g, "$1--url$2")
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits } = await rewriteCliCalls(cwd, rewrite)
  return {
    summary: edits.length ? `moved ${calls} vitehub call(s) from --server to --url` : "found no vitehub call with --server",
    edits,
    followUps: [],
    notes: calls ? ["`--server` is now `--url`, the app URL. A `--url` that names the Console (a `/_vitehub` path) now fails: pass the app URL without `/_vitehub`."] : [],
    nextSteps: [],
  }
}

export const cliUrlFlag: Codemod = {
  name: "cli-url-flag",
  description: "Use --url, the app URL, in vitehub calls of scripts and CI instead of --server",
  usage: "[dir]",
  async detect({ cwd }) {
    const [edit] = (await migrate({ cwd })).edits
    return edit ? { reason: `${edit.path} passes --server to vitehub` } : undefined
  },
  run: migrate,
}
