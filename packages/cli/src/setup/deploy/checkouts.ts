import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

import { callOperationFromCli } from "@vite-hub/internal/operations"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

/** The lock file of `vitehub pull` and `vitehub push`, at the project root. */
const lockFile = "vitehub.lock"

/** The local state of one checkout folder, as `localCheckoutStatus()` returns it. */
interface CheckoutStatus {
  workspace: string
  dir: string
  local: { conflicted: string[] }
}

/** What `pushWorkspaces()` returns for one checkout folder, the same as `vitehub push --json`. */
export interface CheckoutPushResult {
  workspace: string
  ref: string
  /** The new head. Undefined when nothing changed locally. */
  revision?: string
  pushed: string[]
  /** The pull that runs before the push. */
  pull: {
    ref: string
    from: string | null
    head: string | null
    files: Array<{ path: string, action: string, note?: string }>
  }
  /** The pull after the first push to a new ref that inherits files from another ref. */
  after?: CheckoutPushResult["pull"]
}

export interface CheckoutPushError {
  code: string
  message: string
  fix?: string
}

/** `checkouts` of `vitehub deploy --json`: the push results and the files to commit, or the error of the push. */
export type DeployCheckoutsOutput = { results: CheckoutPushResult[], changed: string[] } | { error: CheckoutPushError }

type CheckoutCall = (operation: string, input: unknown, remote: string | undefined) => ReturnType<typeof callOperationFromCli>

/** The part of `@vite-hub/workspace/checkout` that deploy uses. */
interface CheckoutModule {
  localCheckoutStatus: (rootDir: string) => Promise<CheckoutStatus[] | undefined>
  pushWorkspaces: (context: { call: CheckoutCall, rootDir: string }) => Promise<CheckoutPushResult[]>
}

function isCheckoutModule(value: unknown): value is CheckoutModule {
  return Object(value) === value && typeof Reflect.get(Object(value), "localCheckoutStatus") === "function" && typeof Reflect.get(Object(value), "pushWorkspaces") === "function"
}

/** The checkout module of the Workspace package. */
const checkoutSpecifiers = ["@vite-hub/workspace/checkout", "vite-hub/workspace/checkout"]

/** True when `specifier` itself does not resolve: the package is not installed, or it has no `./checkout` export. */
function isNotInstalled(error: unknown, specifier: string): boolean {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return true
  return code === "MODULE_NOT_FOUND" && error instanceof Error && error.message.includes(`'${specifier}'`)
}

/**
 * The checkout module of the Workspace package that the project installs. Undefined only when no specifier resolves.
 * A module that resolves but does not load stops the deploy, because a silent skip would deploy without the push.
 */
async function importCheckoutModule(root: string): Promise<CheckoutModule | undefined> {
  const require = createRequire(join(root, "package.json"))
  for (const specifier of checkoutSpecifiers) {
    let file: string
    try {
      file = require.resolve(specifier)
    }
    catch (error: unknown) {
      if (isNotInstalled(error, specifier)) continue
      throw moduleFailure(specifier, specifier, error)
    }
    let module: unknown
    try {
      module = await import(pathToFileURL(file).href)
    }
    catch (error: unknown) {
      throw moduleFailure(specifier, file, error)
    }
    if (!isCheckoutModule(module)) throw moduleFailure(specifier, file, new TypeError("It does not export localCheckoutStatus and pushWorkspaces."))
    return module
  }
  return undefined
}

function moduleFailure(specifier: string, file: string, error: unknown): SetupFailure {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CHECKOUT_MODULE_FAILED({ file, message, specifier }), setupExitCodes.error)
}

/**
 * True when `vitehub.lock` lists at least one checkout folder. False without a lock. A lock that is not JSON, such as
 * one with a Git conflict, counts, so the checkout module reports it.
 */
async function lockHasCheckouts(root: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(join(root, lockFile), "utf8")
  }
  catch (error: unknown) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false
    throw error
  }
  let lock: unknown
  try {
    lock = JSON.parse(source)
  }
  catch {
    return true
  }
  const workspaces = Object(lock) === lock ? Reflect.get(Object(lock), "workspaces") : undefined
  return Object(workspaces) === workspaces && Object.keys(Object(workspaces)).length > 0
}

/** The checkout folders that `vitehub deploy` pushes after a deploy. */
export interface DeployCheckouts {
  root: string
  module: CheckoutModule
  statuses: CheckoutStatus[]
}

/**
 * Reads the checkout folders of `vitehub.lock` without asking the remote. Undefined when the project has no lock file,
 * no checkout, or no Workspace package to read them: then deploy does not push. Without a checkout, deploy does not
 * load the Workspace package. Without the package, a lock with checkouts gets one warning on `stderr`. Throws when the
 * package does not load, or when a checkout has an open conflict, because the push would refuse it after the deploy.
 */
export async function readDeployCheckouts(root: string, stderr: Pick<ViteHubCliContext["stderr"], "write">): Promise<DeployCheckouts | undefined> {
  if (!await lockHasCheckouts(root)) return undefined
  const module = await importCheckoutModule(root)
  if (!module) {
    stderr.write("[vitehub] vitehub.lock has checkout folders, but the deploy does not push them because the Workspace package is not installed. Install @vite-hub/workspace or vite-hub.\n")
    return undefined
  }
  const statuses = await module.localCheckoutStatus(root)
  if (!statuses?.length) return undefined
  const conflicts = statuses.flatMap(status => status.local.conflicted.map(path => `${status.dir}/${path}`))
  if (conflicts.length) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CHECKOUT_CONFLICT({ files: conflicts.join(", ") }), setupExitCodes.error)
  return { module, root, statuses }
}

async function readLock(root: string): Promise<string | undefined> {
  return await readFile(join(root, lockFile), "utf8").catch(() => undefined)
}

/**
 * Pushes every checkout folder, as `vitehub push` does. The `remote` of each lock entry decides where it goes. Returns
 * the results and the files that the push changed: `vitehub.lock`, and the files that its pull wrote.
 */
export async function pushDeployCheckouts(checkouts: DeployCheckouts, context: Pick<ViteHubCliContext, "env" | "fetch">): Promise<{ results: CheckoutPushResult[], changed: string[] }> {
  const before = await readLock(checkouts.root)
  const call: CheckoutCall = async (operation, input, remote) => await callOperationFromCli({
    env: context.env,
    ...(context.fetch ? { fetch: context.fetch } : {}),
    rootDir: checkouts.root,
    timeout: 120_000,
    ...(remote ? { url: remote } : {}),
  }, operation, input)
  const results = await checkouts.module.pushWorkspaces({ call, rootDir: checkouts.root })
  const dirs = new Map(checkouts.statuses.map(status => [status.workspace, status.dir]))
  const pulled = results.flatMap(result => [...result.pull.files, ...(result.after?.files ?? [])]
    .filter(file => file.action !== "kept")
    .map(file => `${dirs.get(result.workspace) ?? result.workspace}/${file.path}`))
  const changed = [...(before === await readLock(checkouts.root) ? [] : [lockFile]), ...pulled]
  return { changed, results }
}

/** The code, message, and fix of a failed push, as `vitehub push --json` prints them. */
export function checkoutPushError(error: unknown): CheckoutPushError {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined
  const fix = error instanceof Error ? Reflect.get(error, "fix") : undefined
  return {
    code: typeof code === "string" ? code : "WORKSPACE_CHECKOUT_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof fix === "string" ? { fix } : {}),
  }
}

function formatPull(result: CheckoutPushResult["pull"], workspace: string): string {
  if (result.from === result.head && !result.files.length) return ""
  const lines = [`${workspace}: pulled ${result.ref} ${result.from ?? "(empty)"} -> ${result.head ?? "(empty)"}`]
  for (const file of result.files) lines.push(`  ${file.action.padEnd(8)} ${file.path}${file.note ? `\n           ${file.note}` : ""}`)
  return `${lines.join("\n")}\n`
}

/** The text of `vitehub push`, then the files to commit. */
export function formatDeployCheckouts(pushed: { results: CheckoutPushResult[], changed: string[] }): string {
  const text = pushed.results.map((result) => {
    const pulled = formatPull(result.pull, result.workspace)
    if (!result.revision) return `${pulled}${result.workspace}: nothing to push.\n`
    return `${pulled}${result.workspace}: pushed ${result.pushed.length} ${result.pushed.length === 1 ? "file" : "files"} to ${result.ref} (${result.revision})\n${result.pushed.map(path => `  ${path}`).join("\n")}\n${result.after ? formatPull(result.after, result.workspace) : ""}`
  }).join("")
  if (!pushed.changed.length) return text
  return `${text}The push changed these files. Commit them:\n${pushed.changed.map(path => `  ${path}`).join("\n")}\n`
}
