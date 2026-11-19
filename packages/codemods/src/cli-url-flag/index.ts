import { rewriteCliCalls } from "../shared/cli-calls.ts"

import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { edits, followUps } = await rewriteCliCalls(cwd)
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
