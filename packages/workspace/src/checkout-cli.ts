import { callOperationFromCli } from "@vite-hub/internal/operations"

import { pullWorkspaces, pushWorkspaces, resolveWorkspaceConflicts, WorkspaceCheckoutError, workspaceLockFile, workspaceStatus } from "./checkout.ts"

import type { WorkspaceCheckoutCall, WorkspacePullResult, WorkspacePushResult, WorkspaceStatus } from "./checkout.ts"

export interface WorkspaceCheckoutCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface Parsed {
  positional: string[]
  flags: Map<string, string[]>
}

const valueFlags = new Set(["dir", "message", "ref", "theirs", "timeout", "url"])

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { flags: new Map(), positional: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h") {
      parsed.flags.set("help", [""])
      continue
    }
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const values = parsed.flags.get(name) ?? []
    if (valueFlags.has(name)) {
      const value = inline ?? args[++index]
      if (value === undefined) throw new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_USAGE", `--${name} needs a value.`)
      values.push(value)
    }
    else values.push("")
    parsed.flags.set(name, values)
  }
  return parsed
}

function one(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1)
}

function caller(context: WorkspaceCheckoutCliContext, parsed: Parsed): WorkspaceCheckoutCall {
  const timeout = one(parsed, "timeout")
  return async (operation, input, remote) => {
    const url = one(parsed, "url") ?? remote
    return await callOperationFromCli({
      env: context.env,
      ...(context.fetch ? { fetch: context.fetch } : {}),
      rootDir: context.rootDir,
      ...(timeout ? { timeout: Number(timeout) } : { timeout: 120_000 }),
      ...(url ? { url } : {}),
    }, operation, input)
  }
}

function formatPull(result: WorkspacePullResult): string {
  if (result.from === result.head && !result.files.length) return `${result.workspace}: up to date with ${result.ref}${result.head ? ` (${result.head})` : ""}.\n`
  const lines = [`${result.workspace}: pulled ${result.ref} ${result.from ?? "(empty)"} -> ${result.head ?? "(empty)"}`]
  for (const file of result.files) lines.push(`  ${file.action.padEnd(8)} ${file.path}${file.note ? `\n           ${file.note}` : ""}`)
  return `${lines.join("\n")}\n`
}

function formatPush(result: WorkspacePushResult): string {
  const pulled = result.pull.from === result.pull.head ? "" : formatPull(result.pull)
  if (!result.revision) return `${pulled}${result.workspace}: nothing to push.\n`
  return `${pulled}${result.workspace}: pushed ${result.pushed.length} ${result.pushed.length === 1 ? "file" : "files"} to ${result.ref} (${result.revision})\n${result.pushed.map(path => `  ${path}`).join("\n")}\n`
}

function formatStatus(status: WorkspaceStatus): string {
  const lines = [`${status.workspace}: ${status.dir}/ is ${status.ref} at ${status.head ?? "(empty)"}${status.remote ? ` on ${status.remote}` : ""}`]
  const { local } = status
  const rows = [
    ...local.conflicted.map(path => `  conflict  ${path}`),
    ...local.added.map(path => `  added     ${path}`),
    ...local.modified.filter(path => !local.conflicted.includes(path)).map(path => `  modified  ${path}`),
    ...local.deleted.map(path => `  deleted   ${path}`),
  ]
  lines.push(rows.length ? "Local changes:" : "No local changes.", ...rows)
  if (status.remoteChanges) {
    if (!status.remoteChanges.length) lines.push("No remote changes.")
    else lines.push(`Remote changes since ${status.head ?? "(empty)"} (run \`vitehub pull\`):`, ...status.remoteChanges.map(change => `  ${change.change.padEnd(9)} ${change.path}`))
  }
  return `${lines.join("\n")}\n`
}

const usage = {
  pull: "vitehub pull [workspace] [--dir <folder>] [--ref <ref>] [--url <origin>] [--theirs <path>] [--json]",
  push: "vitehub push [workspace] [--message <text>] [--url <origin>] [--json]",
  resolve: "vitehub resolve <workspace> [path...] [--json]",
  status: "vitehub status [workspace] [--remote] [--check] [--url <origin>] [--json]",
}

const help = {
  pull: `Usage: ${usage.pull}

Merge the remote changes of a Workspace ref into a local folder, and record the remote revision in ${workspaceLockFile}.
The first pull of a Workspace needs --dir, and --ref when the ref is not \`main\`. Later pulls read ${workspaceLockFile}.
Without a workspace, pull every Workspace of ${workspaceLockFile}.

A file that only one side changed takes that side. A text file that both sides changed is merged by line; lines that
both sides changed get Git conflict markers. --theirs <path> takes the remote version of one path. Without --url the
command uses \`remote\` of ${workspaceLockFile}, else the dev server of the project.
`,
  push: `Usage: ${usage.push}

Pull, then commit the local changes of each checkout folder to its ref in one revision. It writes the ref only: it
never publishes or deploys. The push refuses while a file has conflict markers or a binary conflict is open. When
another push lands first, it pulls and tries again.
`,
  resolve: `Usage: ${usage.resolve}

Keep your local version of binary files that both sides changed. Without paths, resolve every one. Text conflicts need
no command: remove the markers from the file.
`,
  status: `Usage: ${usage.status}

Show the local changes of each checkout folder against the last pulled revision. --remote also lists the files that
changed on the remote since then. --check exits with 1 when a conflict is open, for a pre-commit hook.
`,
}

async function run(command: keyof typeof usage, args: readonly string[], context: WorkspaceCheckoutCliContext): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parse(args)
  }
  catch (error) {
    context.stderr.write(`${(error as Error).message}\nUsage: ${usage[command]}\n`)
    return 1
  }
  if (parsed.flags.has("help")) {
    context.stdout.write(help[command])
    return 0
  }
  const json = parsed.flags.has("json")
  const write = (value: unknown, text: string) => context.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text)
  const [workspace, ...paths] = parsed.positional
  const checkout = { call: caller(context, parsed), rootDir: context.rootDir }
  try {
    if (command === "pull") {
      const dir = one(parsed, "dir")
      const ref = one(parsed, "ref")
      const url = one(parsed, "url")
      const results = await pullWorkspaces(checkout, { ...(workspace ? { workspace } : {}), ...(dir ? { dir } : {}), ...(ref ? { ref } : {}), ...(url ? { remote: url } : {}), theirs: parsed.flags.get("theirs") ?? [] })
      write(results, results.map(formatPull).join(""))
      return results.some(result => result.files.some(file => file.action === "conflict")) ? 1 : 0
    }
    if (command === "push") {
      const message = one(parsed, "message")
      const results = await pushWorkspaces(checkout, { ...(workspace ? { workspace } : {}), ...(message ? { message } : {}) })
      write(results, results.map(formatPush).join(""))
      return 0
    }
    if (command === "status") {
      const results = await workspaceStatus(checkout, { ...(workspace ? { workspace } : {}), remote: parsed.flags.has("remote") })
      write(results, results.map(formatStatus).join(""))
      return parsed.flags.has("check") && results.some(result => result.local.conflicted.length) ? 1 : 0
    }
    if (!workspace) {
      context.stderr.write(`Name a Workspace.\nUsage: ${usage.resolve}\n`)
      return 1
    }
    const resolved = await resolveWorkspaceConflicts(context.rootDir, workspace, paths)
    write(resolved, resolved.length ? `Resolved: ${resolved.join(", ")}\n` : "No open binary conflicts.\n")
    return 0
  }
  catch (error) {
    const failure = error instanceof WorkspaceCheckoutError ? error : new WorkspaceCheckoutError("WORKSPACE_CHECKOUT_FAILED", error instanceof Error ? error.message : String(error))
    if (json) context.stdout.write(`${JSON.stringify({ code: failure.code, message: failure.message, ...(failure.fix ? { fix: failure.fix } : {}) }, null, 2)}\n`)
    else context.stderr.write(`${failure.code}: ${failure.message}\n${failure.fix ? `${failure.fix}\n` : ""}`)
    return 1
  }
}

/** `vitehub pull|push|status|resolve`: a local folder as a working copy of a Workspace ref. */
export function workspaceCheckoutFeatures(): Array<{ description: string, name: string, run: (args: string[], context: WorkspaceCheckoutCliContext) => Promise<number>, usage: string }> {
  return [
    { description: "Merge the remote changes of a Workspace ref into a local folder.", name: "pull", run: async (args, context) => await run("pull", args, context), usage: usage.pull },
    { description: "Pull, then commit the local changes of a checkout folder to its ref.", name: "push", run: async (args, context) => await run("push", args, context), usage: usage.push },
    { description: "Show local and remote changes of each checkout folder.", name: "status", run: async (args, context) => await run("status", args, context), usage: usage.status },
    { description: "Keep the local version of binary files that both sides changed.", name: "resolve", run: async (args, context) => await run("resolve", args, context), usage: usage.resolve },
  ]
}
