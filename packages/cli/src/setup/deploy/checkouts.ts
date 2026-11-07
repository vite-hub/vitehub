import { existsSync } from "node:fs"
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

/** The checkout module of the Workspace package that the project installs, if it has one. */
async function importCheckoutModule(root: string): Promise<CheckoutModule | undefined> {
  const require = createRequire(join(root, "package.json"))
  for (const specifier of ["@vite-hub/workspace/checkout", "vite-hub/workspace/checkout"]) {
    let module: unknown
    try {
      module = await import(pathToFileURL(require.resolve(specifier)).href)
    }
    catch {
      continue
    }
    if (isCheckoutModule(module)) return module
  }
  return undefined
}

/** The checkout folders that `vitehub deploy` pushes after a deploy. */
export interface DeployCheckouts {
  root: string
  module: CheckoutModule
  statuses: CheckoutStatus[]
}

/**
 * Reads the checkout folders of `vitehub.lock` without asking the remote. Undefined when the project has no lock file,
 * no checkout, or no Workspace package to read them: then deploy does not push. Throws when a checkout has an open
 * conflict, because the push would refuse it after the deploy.
 */
export async function readDeployCheckouts(root: string): Promise<DeployCheckouts | undefined> {
  if (!existsSync(join(root, lockFile))) return undefined
  const module = await importCheckoutModule(root)
  if (!module) return undefined
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
  const pulled = results.flatMap(result => result.pull.files
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
    return `${pulled}${result.workspace}: pushed ${result.pushed.length} ${result.pushed.length === 1 ? "file" : "files"} to ${result.ref} (${result.revision})\n${result.pushed.map(path => `  ${path}`).join("\n")}\n`
  }).join("")
  if (!pushed.changed.length) return text
  return `${text}The push changed these files. Commit them:\n${pushed.changed.map(path => `  ${path}`).join("\n")}\n`
}
