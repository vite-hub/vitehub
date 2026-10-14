import { isAbsolute } from "node:path"

import { hasRuntimeType, isRuntimeObject } from "@vite-hub/runtime/internal/runtime-type"

import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

/**
 * A Workspace Definition that another package registers from its Vite plugin. The Workspace plugin adds it to the
 * generated registry next to the discovered files, so `useWorkspace(name)`, typegen, inspection, and the Console
 * treat it like `server/workspaces/<name>.ts`.
 */
export interface WorkspaceContribution {
  /** Workspace name. Must not match a discovered Workspace or another contribution. */
  name: string
  /**
   * Module that holds the `defineWorkspace()` result: an absolute file path, or a package specifier that the
   * application can import. Relative paths are rejected because they have no stable base.
   */
  module: string
  /** Named export that holds the Workspace Definition. Defaults to `default`. */
  export?: string
}

/** Project roots that the Workspace plugin passes to contribution factories. */
export interface WorkspaceContributionContext {
  /** ViteHub project root. */
  projectRoot: string
  /** Vite root. */
  rootDir: string
  /** Server directories that the host forwards, for example Nuxt's `serverDir`. */
  serverDirs?: string[]
}

export type WorkspaceContributionFactory = (context: WorkspaceContributionContext) =>
  | readonly WorkspaceContribution[]
  | undefined
  | Promise<readonly WorkspaceContribution[] | undefined>

/** Vite plugin metadata that contributes Workspace Definitions. */
export interface WorkspaceContributionPluginMetadata {
  /**
   * Workspace Definitions to add. A factory runs once per discovery pass, so it must be idempotent and must not
   * depend on the order of Vite config hooks.
   */
  workspaces?: readonly WorkspaceContribution[] | WorkspaceContributionFactory
}

export interface WorkspaceContributingPlugin {
  name?: string
  vitehub?: WorkspaceContributionPluginMetadata
}

/** A validated contribution with the name of the plugin that contributed it. */
export interface CollectedWorkspaceContribution extends WorkspaceContribution {
  contributor: string
}

function flattenPluginOptions(value: unknown, plugins: object[], seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenPluginOptions(item, plugins, seen)
    return
  }
  // Vite resolves promised plugin options before `configResolved`. The `config` hook sees the raw user list, so only
  // synchronous plugin objects can contribute there.
  if (!isRuntimeObject(value) || seen.has(value) || hasRuntimeType(Reflect.get(value, "then"), "function")) return
  seen.add(value)
  plugins.push(value)
}

function isNonEmptyString(value: unknown): value is string {
  return hasRuntimeType(value, "string") && value.length > 0
}

function invalidContribution(contributor: string, reason: string): Error {
  return workspaceErrorDiagnostics.WORKSPACE_B0004({ message: `[vitehub] Plugin "${contributor}" contributed an invalid Workspace Definition: ${reason}` })
}

function validateContribution(value: unknown, contributor: string): CollectedWorkspaceContribution {
  if (!isRuntimeObject(value)) throw invalidContribution(contributor, "expected { name, module, export? }.")
  const name: unknown = Reflect.get(value, "name")
  const module: unknown = Reflect.get(value, "module")
  const exportName: unknown = Reflect.get(value, "export")
  if (!isNonEmptyString(name) || name.trim() !== name) {
    throw invalidContribution(contributor, "`name` must be a non-empty string without surrounding whitespace.")
  }
  if (!isNonEmptyString(module)) {
    throw invalidContribution(contributor, `Workspace "${name}" needs a \`module\` string.`)
  }
  if (!isAbsolute(module) && (module.startsWith("./") || module.startsWith("../") || module === "." || module === "..")) {
    throw invalidContribution(contributor, `Workspace "${name}" module ${JSON.stringify(module)} is relative. Use an absolute file path or a package specifier.`)
  }
  if (exportName !== undefined && !isNonEmptyString(exportName)) {
    throw invalidContribution(contributor, `Workspace "${name}" \`export\` must be a non-empty string.`)
  }
  const contribution: CollectedWorkspaceContribution = { contributor, module, name }
  if (exportName !== undefined && exportName !== "default") contribution.export = exportName
  return contribution
}

function sameContribution(left: WorkspaceContribution, right: WorkspaceContribution): boolean {
  return left.name === right.name && left.module === right.module && (left.export ?? "default") === (right.export ?? "default")
}

export function describeWorkspaceContribution(contribution: WorkspaceContribution & { contributor?: string }): string {
  const target = contribution.export ? `${contribution.module}#${contribution.export}` : contribution.module
  return contribution.contributor ? `${target} (contributed by "${contribution.contributor}")` : target
}

/**
 * Collects `vitehub.workspaces` contributions from Vite plugins. The same contribution from two plugin instances is
 * kept once; two different contributions with one name fail with `WORKSPACE_B0003`.
 */
export async function collectWorkspaceContributions(
  plugins: readonly unknown[] | undefined,
  context: WorkspaceContributionContext,
): Promise<CollectedWorkspaceContribution[]> {
  const candidates: object[] = []
  flattenPluginOptions(plugins ?? [], candidates, new Set())
  const contributions = new Map<string, CollectedWorkspaceContribution>()
  for (const plugin of candidates) {
    if (!Object.hasOwn(plugin, "vitehub")) continue
    const metadata: unknown = Reflect.get(plugin, "vitehub")
    const value: unknown = isRuntimeObject(metadata) ? Reflect.get(metadata, "workspaces") : undefined
    if (!value) continue
    const pluginName: unknown = Reflect.get(plugin, "name")
    const contributor = isNonEmptyString(pluginName) ? pluginName : "unnamed plugin"
    const entries: unknown = hasRuntimeType(value, "function") ? await Reflect.apply(value, undefined, [context]) : value
    if (!entries) continue
    if (!Array.isArray(entries)) throw invalidContribution(contributor, "`vitehub.workspaces` must be an array or return one.")
    for (const entry of entries) {
      const contribution = validateContribution(entry, contributor)
      const existing = contributions.get(contribution.name)
      if (existing && !sameContribution(existing, contribution)) {
        throw workspaceErrorDiagnostics.WORKSPACE_B0003({ message: `[vitehub] Workspace "${contribution.name}" is defined more than once:\n  - ${describeWorkspaceContribution(existing)}\n  - ${describeWorkspaceContribution(contribution)}\nEach Workspace name must have one definition.` })
      }
      if (!existing) contributions.set(contribution.name, contribution)
    }
  }
  return [...contributions.values()]
}
