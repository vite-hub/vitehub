import { rewriteCliCalls } from "./cli-calls.ts"

import type { ShellWord } from "./cli-calls.ts"
import type { Codemod, CodemodContext, CodemodResult } from "../types.ts"

/** `get` reads one record and `list` reads many. Each entry rewrites the start of the arguments after `vitehub `. */
const renames: ReadonlyArray<[RegExp, string]> = [
  [/^agent\s+info(?=\s|$)/, "agent get"],
  [/^agent\s+invocations\s+show(?=\s|$)/, "agent invocations get"],
  [/^content\s+show(?=\s|$)/, "content get"],
  [/^email\s+outbox\s+show(?=\s|$)/, "email outbox get"],
  [/^queue\s+jobs\s+show(?=\s|$)/, "queue jobs get"],
  [/^workspace\s+show(?=\s|$)/, "workspace get"],
  [/^schedule\s+attempts(?=\s|$)/, "schedule runs get"],
  [/^env\s+inspect(?=\s|$)/, "env list"],
  [/^project\s+info(?=\s|$)/, "project get"],
]

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, "$2")
}

function rewrite(args: string, words: readonly ShellWord[]): string | { message: string } {
  const [namespace, command, subcommand] = words.map(word => word.text)
  if (namespace === "definitions" && command === "list") {
    return { message: "`definitions list` was removed. Use `vitehub inspect definitions --kind <kind>` for local definitions, or the Console for runtime records." }
  }
  if (namespace === "schedule" && command === "runs" && subcommand && !["list", "get", "-h", "--help"].includes(unquote(subcommand))) {
    return `schedule runs list${args.slice(words[1]!.start + "runs".length)}`
  }
  if (namespace === "env" && command === "status") {
    const options = words.slice(2).map(word => unquote(word.text))
    let url = false
    let json = false
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!
      if (option === "--json") json = true
      else if (option === "--url" && options[index + 1] && !options[index + 1]!.startsWith("-")) {
        url = true
        index++
      }
      else if (/^--url=[^-].*$/.test(option)) url = true
      else return { message: "Update `env status` to `vitehub env list --url <app> --json`. Review the old options: `env list` does not accept `--input` or `--timeout`." }
    }
    if (!url) return { message: "`env status` read a running dev server. Pass its URL explicitly to `vitehub env list --url <app> --json` to keep that target." }
    return `env list${json ? "" : " --json"}${args.slice(words[1]!.start + "status".length)}`
  }
  if (namespace === "workflow" && (command === "get" || (command === "runs" && subcommand === "show"))) {
    const show = command === "runs"
    const last = words[show ? 2 : 1]!
    const end = last.start + last.text.length
    let tail = args.slice(end)
    let json = false
    const flags: Array<{ start: number, end: number, value: string }> = []
    for (let index = show ? 3 : 2; index < words.length; index++) {
      const word = words[index]!
      const option = unquote(word.text)
      if (option === "--") break
      if (option === "--json") json = true
      const name = option.split("=", 1)[0]
      if (show && name === "--input") return { message: "Update `workflow runs show` to `vitehub workflow runs get` and rename `id` to `runId` in its `--input` JSON or file." }
      if (show && name === "--id") {
        if (!word.text.startsWith("--id")) return { message: "Update `workflow runs show` to `vitehub workflow runs get` and pass `--run-id` instead of `--id`." }
        flags.push({ start: word.start - end, end: word.start + "--id".length - end, value: "--run-id" })
      }
      if (name === option && ["--id", "--run-id", "--input", "--url", "--workflow", "--timeout"].includes(option)) index++
    }
    for (const flag of flags.reverse()) tail = `${tail.slice(0, flag.start)}${flag.value}${tail.slice(flag.end)}`
    return `workflow runs get${show || json ? "" : " --json"}${tail}`
  }
  for (const [pattern, now] of renames) if (pattern.test(args)) return args.replace(pattern, now)
  return args
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { calls, edits, followUps } = await rewriteCliCalls(cwd, rewrite)
  return {
    summary: edits.length ? `renamed ${calls} vitehub call(s) to get and list` : followUps.length ? "found renamed read commands that need manual migration" : "found no vitehub call with a renamed read command",
    edits,
    followUps,
    notes: [],
    nextSteps: [],
  }
}

export const cliGetList: Codemod = {
  name: "cli-get-list",
  description: "Rename vitehub read commands in scripts and CI: show and info to get, env inspect and env status to env list, schedule runs to runs list, and more",
  usage: "[dir]",
  async detect({ cwd }) {
    const { edits, followUps } = await migrate({ cwd })
    const file = edits[0]?.path ?? followUps[0]?.file
    return file ? { reason: `${file} calls a renamed vitehub read command` } : undefined
  },
  run: migrate,
}
