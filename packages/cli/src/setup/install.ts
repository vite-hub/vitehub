import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"

import { isRecord } from "@vite-hub/internal/object"
import { dirname, join, relative } from "pathe"
import { isMap, parseDocument, stringify } from "yaml"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { setupExitCodes, setupFailure } from "./envelope.ts"
import { declaresNuxt5, pnpmWorkspaceFile } from "./project.ts"
import { formatInstallCommand, installArgs } from "./status.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { FeatureId } from "@vite-hub/internal/features"
import type { Document } from "yaml"
import type { SetupPackageManager, SetupProject } from "./project.ts"

/**
 * The packages with build scripts that a ViteHub app installs: Nuxt 4 and Workflow install esbuild, Workflow installs
 * `@swc/core` and cbor-extract, and Wrangler on Cloudflare installs esbuild and workerd. pnpm 11 and later stop the
 * install while a build script waits for approval. Each of these packages runs without its build script: esbuild,
 * workerd, and `@swc/core` load the binary of their platform package, and cbor-extract loads its prebuilt addon, so the
 * app declines every one of them.
 */
export function declinedBuilds(project: Pick<SetupProject, "framework" | "nuxt">, host: ViteHubHost | "unknown", features: readonly FeatureId[]): string[] {
  const workflow = features.includes("workflow")
  const cloudflare = host === "cloudflare"
  return [
    ...((project.framework === "nuxt" && !declaresNuxt5(project.nuxt)) || workflow || cloudflare ? ["esbuild"] : []),
    ...(cloudflare ? ["workerd"] : []),
    ...(workflow ? ["@swc/core", "cbor-extract"] : []),
  ]
}

/** A change to the pnpm build policy. `path` is relative to the project root, and `file` is absolute. */
export interface PnpmBuildsChange {
  path: string
  file: string
  before?: string
  after: string
}

function named(policy: unknown, name: string): boolean {
  if (!isRecord(policy)) return false
  if (policy.dangerouslyAllowAllBuilds === true) return true
  if (isRecord(policy.allowBuilds) && Object.hasOwn(policy.allowBuilds, name)) return true
  return ["onlyBuiltDependencies", "ignoredBuiltDependencies", "neverBuiltDependencies"].some((key) => {
    const list = policy[key]
    return Array.isArray(list) && list.includes(name)
  })
}

/**
 * Adds `allowBuilds: { <name>: false }` for each of `names` that the pnpm build policy does not name yet. It edits the
 * `pnpm-workspace.yaml` of the project or of its pnpm workspace, or creates one in the project. Undefined when the
 * package manager is not pnpm, or when the policy already names every package.
 */
export function planPnpmBuilds(project: Pick<SetupProject, "packageManager" | "root">, names: readonly string[]): PnpmBuildsChange | undefined {
  if (project.packageManager !== "pnpm" || !names.length) return
  const file = pnpmWorkspaceFile(project.root) ?? join(project.root, "pnpm-workspace.yaml")
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
  const document = parseDocument(before ?? "")
  if (document.errors.length || (before?.trim() && !isMap(document.contents))) return
  const policy: unknown = document.toJS()
  const missing = names.filter(name => !named(policy, name))
  if (!missing.length) return
  return { after: withDeclined(document, before, missing), file, path: relative(project.root, file), ...(before === undefined ? {} : { before }) }
}

function withDeclined(document: Document, before: string | undefined, names: readonly string[]): string {
  if (!document.has("allowBuilds")) return `${before?.trim() ? `${before.trimEnd()}\n` : ""}${stringify({ allowBuilds: Object.fromEntries(names.map(name => [name, false])) })}`
  for (const name of names) document.setIn(["allowBuilds", name], false)
  return document.toString()
}

/** Writes a planned build policy change. Throws when the file changed after the plan. */
export async function writePnpmBuilds(change: PnpmBuildsChange): Promise<void> {
  if (change.before === undefined) {
    await mkdir(dirname(change.file), { recursive: true })
    try {
      await writeFile(change.file, change.after, { flag: "wx" })
    }
    catch {
      throw setupFailure(cliErrorDiagnostics.SETUP_FILE_EXISTS({ file: change.path }), setupExitCodes.conflict)
    }
    return
  }
  if (await readFile(change.file, "utf8") !== change.before) throw setupFailure(cliErrorDiagnostics.SETUP_STALE_PLAN({ file: change.path }), setupExitCodes.stalePlan)
  await writeFile(change.file, change.after)
}

function ignoredBuilds(output: string): string[] {
  const line = output.match(/Ignored build scripts:([^\n]+)/u)?.[1]
  return line ? line.split(",").map(spec => spec.trim().replace(/(?<=.)@[^@]*$/u, "")).filter(Boolean) : []
}

/** What the setup command reports when an install fails. `filesWritten` is `possible` after a scaffold that may have written files. */
export interface SetupInstallFailure {
  filesWritten: boolean | "possible"
  root: string
}

/**
 * Installs `packages` with the package manager. The package manager's error output still reaches the terminal, and a
 * failure throws `SETUP_INSTALL_FAILED` with that output, so `--json` shows the real error too.
 */
export async function installPackages(context: Pick<ViteHubCliContext, "env" | "spawn"> & Partial<Pick<ViteHubCliContext, "stderr">>, packageManager: SetupPackageManager, packages: readonly string[], dev: boolean, failure: SetupInstallFailure): Promise<void> {
  const commandArgs = installArgs(packageManager, packages, dev)
  const result = await context.spawn(packageManager, commandArgs, { cwd: failure.root, env: context.env, stderr: "pipe", stdout: "stderr" })
  if (result.stderr) context.stderr?.write(result.stderr)
  if (result.exitCode === 0) return
  const output = result.stderr?.trim().split("\n").map(line => line.trimEnd()).filter(Boolean).slice(-20).join("\n")
  const ignored = packageManager === "pnpm" && output ? ignoredBuilds(output) : []
  throw setupFailure(cliErrorDiagnostics.SETUP_INSTALL_FAILED({
    command: formatInstallCommand(packageManager, commandArgs),
    exitCode: result.exitCode ?? result.signal,
    filesWritten: failure.filesWritten,
    ...(output ? { output } : {}),
    ...(ignored.length ? { ignored, workspaceFile: pnpmWorkspaceFile(failure.root) ?? join(failure.root, "pnpm-workspace.yaml") } : {}),
  }), setupExitCodes.error)
}
