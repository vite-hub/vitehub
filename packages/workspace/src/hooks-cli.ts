import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

import { formatWorkspaceStatus, ignoredName, localCheckoutStatus, workspaceLockFile } from "./checkout.ts"
import { workspaceCheckoutFeatures } from "./checkout-cli.ts"

import type { WorkspaceCheckoutCliContext } from "./checkout-cli.ts"

const exec = promisify(execFile)
const marker = "# Installed by `vitehub hooks install`."
const hookNames = ["pre-commit", "pre-push"] as const
type HookName = typeof hookNames[number]

const usage = {
  install: "vitehub hooks install",
  "pre-commit": "vitehub hooks pre-commit",
  "pre-push": "vitehub hooks pre-push",
  uninstall: "vitehub hooks uninstall",
}

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return (await exec("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } })).stdout.trim()
  }
  catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

/** The hook manager that owns the hooks of the repository, such as Husky, or undefined when Git runs `.git/hooks`. */
async function hookManager(top: string, rootDir: string): Promise<string | undefined> {
  if (await exists(join(top, ".husky"))) return "Husky"
  for (const file of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) if (await exists(join(top, file))) return "lefthook"
  if (await exists(join(top, ".pre-commit-config.yaml"))) return "pre-commit"
  for (const dir of new Set([top, rootDir])) {
    const manifest = await readFile(join(dir, "package.json"), "utf8").catch(() => undefined)
    if (manifest?.includes("\"simple-git-hooks\"")) return "simple-git-hooks"
  }
  const hooksPath = await git(top, "config", "--get", "core.hooksPath")
  return hooksPath ? `core.hooksPath (${hooksPath})` : undefined
}

/** A shell word for a value, such as a project path with spaces or quotes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The hook file that `install` writes. A hook with any other content is not ViteHub's. */
function script(hook: HookName, project: string): string {
  const cd = project ? `"$(git rev-parse --show-toplevel)"/${shellQuote(project)}` : `"$(git rev-parse --show-toplevel)"`
  return [
    "#!/bin/sh",
    marker,
    `cd ${cd} || exit 1`,
    `if [ -x node_modules/.bin/vitehub ]; then exec node_modules/.bin/vitehub hooks ${hook} "$@"; fi`,
    `exec npx --no-install vitehub hooks ${hook} "$@"`,
    "",
  ].join("\n")
}

function manualLines(project: string): string {
  const prefix = project ? `cd ${shellQuote(project)} && ` : ""
  return `  pre-commit: ${prefix}vitehub hooks pre-commit\n  pre-push:   ${prefix}vitehub hooks pre-push\n`
}

/** The top folder of the Git repository and the project folder inside it. */
async function repository(rootDir: string): Promise<{ project: string, top: string } | undefined> {
  const top = await git(rootDir, "rev-parse", "--show-toplevel")
  return top ? { project: relative(top, rootDir).split(sep).join("/"), top } : undefined
}

async function install(context: WorkspaceCheckoutCliContext): Promise<number> {
  const repo = await repository(context.rootDir)
  if (!repo) {
    context.stderr.write(`${context.rootDir} is not in a Git repository.\n`)
    return 1
  }
  const { project, top } = repo
  const manager = await hookManager(top, context.rootDir)
  if (manager) {
    context.stdout.write(`${manager} runs the Git hooks of this repository, so ViteHub writes no hook file. Add these commands to it:\n${manualLines(project)}`)
    return 0
  }
  const hooks = resolve(context.rootDir, (await git(context.rootDir, "rev-parse", "--git-path", "hooks"))!)
  await mkdir(hooks, { recursive: true })
  const foreign: string[] = []
  for (const hook of hookNames) {
    const path = join(hooks, hook)
    const current = await readFile(path, "utf8").catch(() => undefined)
    if (current !== undefined && current !== script(hook, project)) {
      foreign.push(hook)
      continue
    }
    await writeFile(path, script(hook, project))
    await chmod(path, 0o755)
    context.stdout.write(`Wrote ${relative(top, path)}\n`)
  }
  if (!foreign.length) return 0
  context.stderr.write(`These hooks exist and are not the hooks that ViteHub writes: ${foreign.join(", ")}. Add the ViteHub commands to them:\n${manualLines(project)}`)
  return 1
}

async function uninstall(context: WorkspaceCheckoutCliContext): Promise<number> {
  const repo = await repository(context.rootDir)
  const hooks = await git(context.rootDir, "rev-parse", "--git-path", "hooks")
  if (!repo || !hooks) return 0
  for (const hook of hookNames) {
    const path = resolve(context.rootDir, hooks, hook)
    const current = await readFile(path, "utf8").catch(() => undefined)
    if (current === undefined) continue
    if (current !== script(hook, repo.project)) {
      context.stdout.write(`Left ${hook}: it is not the hook that \`vitehub hooks install\` writes, so it can contain your commands.\n`)
      continue
    }
    await rm(path)
    context.stdout.write(`Removed ${hook}\n`)
  }
  return 0
}

/** True when the project has a lock file with at least one checked-out Workspace. */
async function hasCheckouts(rootDir: string): Promise<boolean> {
  const source = await readFile(join(rootDir, workspaceLockFile), "utf8").catch(() => undefined)
  if (source === undefined) return false
  try {
    const workspaces: unknown = Reflect.get(Object(JSON.parse(source)), "workspaces")
    return Object(workspaces) === workspaces && Object.keys(Object(workspaces)).length > 0
  }
  catch {
    // A lock file with a Git conflict is not JSON. The status command reports it.
    return true
  }
}

/**
 * A digest of `vitehub.lock` and of every file in its checkout folders, by path from the project folder. The pre-push
 * hook compares two of them to find what `vitehub push` changed.
 */
async function checkoutFiles(rootDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const digest = async (path: string) => {
    const bytes = await readFile(join(rootDir, path)).catch(() => undefined)
    if (bytes) files.set(path, createHash("sha256").update(bytes).digest("hex"))
  }
  await digest(workspaceLockFile)
  let dirs: string[] = []
  try {
    const workspaces: unknown = Reflect.get(Object(JSON.parse(await readFile(join(rootDir, workspaceLockFile), "utf8"))), "workspaces")
    dirs = Object.values(Object(workspaces)).map(entry => Reflect.get(Object(entry), "dir")).filter((dir): dir is string => typeof dir === "string")
  }
  catch {
    // `vitehub push` reports a lock file that is not JSON.
  }
  // Skip the folders that `vitehub push` skips without reading them, such as a large `node_modules`.
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (ignoredName(entry.name)) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) await digest(relative(rootDir, path).split(sep).join("/"))
    }
  }
  for (const dir of dirs) await walk(join(rootDir, dir))
  return files
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
}

const feature = (name: string) => workspaceCheckoutFeatures().find(candidate => candidate.name === name)!

/** The branch names that a pre-push hook pushes to, read from the lines that Git writes to its standard input. */
export function pushedBranches(input: string): string[] {
  return input.split("\n").map(line => line.trim().split(/\s+/)[2]).filter((ref): ref is string => ref?.startsWith("refs/heads/") === true).map(ref => ref.slice("refs/heads/".length))
}

async function defaultBranch(rootDir: string): Promise<string> {
  const remote = await git(rootDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
  if (remote) return remote.slice(remote.indexOf("/") + 1)
  return await git(rootDir, "config", "--get", "init.defaultBranch") || "main"
}

async function readStandardInput(): Promise<string> {
  if (process.stdin.isTTY) return ""
  let text = ""
  for await (const chunk of process.stdin) text += String(chunk)
  return text
}

export interface WorkspaceHooksOptions {
  /** The standard input of the pre-push hook. Defaults to the process input. */
  readInput?: () => Promise<string>
}

async function prePush(context: WorkspaceCheckoutCliContext, options: WorkspaceHooksOptions): Promise<number> {
  if (!await hasCheckouts(context.rootDir)) return 0
  const target = await defaultBranch(context.rootDir)
  const branches = pushedBranches(await (options.readInput ?? readStandardInput)())
  if (!branches.includes(target)) {
    context.stdout.write(`vitehub: this push does not update ${target}, so the checkout folders stay unpushed.\n`)
    return 0
  }
  const before = await checkoutFiles(context.rootDir)
  const code = await feature("push").run([], context)
  if (code !== 0) {
    context.stderr.write("vitehub: the Workspace push failed, so Git stops this push. Fix it, or push with --no-verify to skip the hook.\n")
    return code
  }
  const changed = changedFiles(before, await checkoutFiles(context.rootDir))
  if (!changed.length) return 0
  // Git made this push from commits that already exist, so it cannot carry the new lock file or the pulled files.
  context.stderr.write(`vitehub: the Workspace push went through and changed these files:\n${changed.map(path => `  ${path}\n`).join("")}Git stops this push because it does not contain them. Commit them, then run git push again.\n`)
  return 1
}

async function preCommit(context: WorkspaceCheckoutCliContext): Promise<number> {
  if (!await hasCheckouts(context.rootDir)) return 0
  const conflicted = (await localCheckoutStatus(context.rootDir) ?? []).filter(status => status.local.conflicted.length)
  if (!conflicted.length) return 0
  context.stderr.write(`${conflicted.map(formatWorkspaceStatus).join("")}vitehub: a checkout folder has conflicts, so Git stops this commit. Resolve them, then commit again.\n`)
  return 1
}

const help = `Usage: vitehub hooks <install|uninstall|pre-commit|pre-push>

install     Write .git/hooks/pre-commit and pre-push. With Husky, lefthook, pre-commit, simple-git-hooks, or
            core.hooksPath, print the commands to add to that tool instead. An existing hook stays as it is.
uninstall   Remove the hooks that \`install\` wrote. A hook that you changed stays.
pre-commit  Fail while a checkout folder of ${workspaceLockFile} has conflicts. Works offline.
pre-push    Run \`vitehub push\` when the Git push updates the default branch. Other branches push nothing. When the
            Workspace push changes ${workspaceLockFile} or pulls files, the hook fails: commit them, then push again.

Without ${workspaceLockFile}, pre-commit and pre-push do nothing.
`

/** `vitehub hooks`: Git hooks that keep the checkout folders of `vitehub.lock` in step with commits and pushes. */
export function workspaceHooksNamespace(options: WorkspaceHooksOptions = {}): { description: string, features: Array<{ description: string, name: string, run: (args: string[], context: WorkspaceCheckoutCliContext) => Promise<number>, usage: string }>, name: string } {
  const command = (name: keyof typeof usage, description: string, run: (context: WorkspaceCheckoutCliContext) => Promise<number>) => ({
    description,
    name,
    run: async (args: string[], context: WorkspaceCheckoutCliContext) => {
      if (args.includes("--help") || args.includes("-h")) {
        context.stdout.write(help)
        return 0
      }
      return await run(context)
    },
    usage: usage[name],
  })
  return {
    description: "Git hooks that check checkout folders before a commit and push them with the default branch.",
    features: [
      command("install", "Write the pre-commit and pre-push hooks, or print them for your hook manager.", install),
      command("uninstall", "Remove the hooks that install wrote.", uninstall),
      command("pre-commit", "Fail while a checkout folder has conflicts.", preCommit),
      command("pre-push", "Run vitehub push when Git pushes the default branch.", async context => await prePush(context, options)),
    ],
    name: "hooks",
  }
}
