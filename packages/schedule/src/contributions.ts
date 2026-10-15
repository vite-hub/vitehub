import { isAbsolute } from "node:path"

import { isPlainObject } from "@vite-hub/internal/object"

import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

/**
 * A Schedule Definition that another package adds from its Vite plugin. The Schedule plugin merges it with the
 * discovered files, so provider wake output, the Process Runtime, `vitehub schedule run`, generated types, inspection,
 * and the Console treat it like `server/schedules/<name>.ts`.
 *
 * The build reads the cron and the `manual` and `allowRuntimeSchedules` options from the source of the Definition
 * module without running it, as it does for discovered files. The module must therefore follow the file contract:
 * `export default defineSchedule({ cron: "...", handler })` with literal options, or
 * `export default defineScheduleTarget({ handler })`.
 */
export interface ScheduleContribution {
  /** Schedule name. Must not match a discovered Schedule or another contribution. */
  name: string
  /** Absolute path of the module whose default export is the Schedule Definition. */
  definition: string
  /** Why the package adds the Schedule. `vitehub inspect` and the Console show it. */
  reason?: string
}

/** Project roots that the Schedule plugin passes to contribution factories. */
export interface ScheduleContributionContext {
  /** ViteHub project root. */
  projectRoot: string
  /** Vite root. */
  rootDir: string
  /** Server directories that the host forwards, for example Nuxt's `serverDir`. */
  serverDirs?: string[]
}

export type ScheduleContributionFactory = (context: ScheduleContributionContext) =>
  | readonly ScheduleContribution[]
  | undefined
  | Promise<readonly ScheduleContribution[] | undefined>

/** Vite plugin metadata that contributes Schedule Definitions. */
export interface ScheduleContributionPluginMetadata {
  /**
   * Schedule Definitions to add. A factory runs once per discovery pass, so it must be idempotent and must not depend
   * on the order of Vite config hooks.
   */
  schedules?: readonly ScheduleContribution[] | ScheduleContributionFactory
}

export interface ScheduleContributingPlugin {
  name?: string
  vitehub?: ScheduleContributionPluginMetadata
}

/** A validated contribution with the name of the plugin that contributed it. */
export interface CollectedScheduleContribution extends ScheduleContribution {
  contributor: string
}

const scheduleNamePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i

async function flattenPluginOptions(value: unknown, plugins: object[], seen: Set<unknown>): Promise<void> {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) {
    if (seen.has(value)) return
    seen.add(value)
    await flattenPluginOptions(await value, plugins, seen)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) await flattenPluginOptions(item, plugins, seen)
    return
  }
  if (!isPlainObject(value) || seen.has(value)) return
  seen.add(value)
  plugins.push(value)
}

function isNonEmptyString(value: unknown): value is string {
  return String(value) === value && value.length > 0
}

function invalidContribution(contributor: string, reason: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_B0007({ message: `[vitehub] Plugin "${contributor}" contributed an invalid Schedule Definition: ${reason}` })
}

function validateContribution(value: unknown, contributor: string): CollectedScheduleContribution {
  if (!isPlainObject(value)) throw invalidContribution(contributor, "expected { name, definition, reason? }.")
  const { definition, name, reason } = value
  if (!isNonEmptyString(name) || !scheduleNamePattern.test(name)) {
    throw invalidContribution(contributor, "`name` must be letters, numbers, dots, underscores, dashes, and slashes, for example \"content/publish\".")
  }
  if (Object.hasOwn(value, "module") || Object.hasOwn(value, "export")) {
    throw invalidContribution(contributor, `Schedule ${JSON.stringify(name)} uses \`module\`/\`export\`. Schedule contributions take { name, definition, reason? }: \`definition\` is the absolute path of a module whose default export is defineSchedule(), because the build reads its cron from source.`)
  }
  if (!isNonEmptyString(definition) || !isAbsolute(definition)) {
    throw invalidContribution(contributor, `Schedule ${JSON.stringify(name)} needs \`definition\`, the absolute path of its Definition module.`)
  }
  if (reason !== undefined && !isNonEmptyString(reason)) {
    throw invalidContribution(contributor, `\`reason\` of Schedule ${JSON.stringify(name)} must be a non-empty string.`)
  }
  const contribution: CollectedScheduleContribution = { contributor, definition, name }
  if (reason !== undefined) contribution.reason = reason
  return contribution
}

/** Describes a contribution as `definition (contributed by "plugin")` for errors. */
export function describeScheduleContribution(contribution: Pick<ScheduleContribution, "definition"> & { contributor?: string }): string {
  return contribution.contributor ? `${contribution.definition} (contributed by "${contribution.contributor}")` : contribution.definition
}

/** Error for a Schedule name with two definitions. Both sources are named so the user knows which to rename. */
export function duplicateScheduleError(name: string, first: string, second: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_B0006({ message: `[vitehub] Schedule "${name}" is defined more than once:\n  - ${first}\n  - ${second}\nRename or remove one definition. Each Schedule name must have one definition.` })
}

/**
 * Collects `vitehub.schedules` contributions from Vite plugins. The same contribution from two plugin instances is kept
 * once; two different Definitions with one name fail with `SCHEDULE_B0006`. Invalid entries fail with `SCHEDULE_B0007`.
 */
export async function collectScheduleContributions(
  plugins: readonly unknown[] | undefined,
  context: ScheduleContributionContext,
): Promise<CollectedScheduleContribution[]> {
  const candidates: object[] = []
  await flattenPluginOptions(plugins ?? [], candidates, new Set())
  const contributions = new Map<string, CollectedScheduleContribution>()
  for (const plugin of candidates) {
    if (!Object.hasOwn(plugin, "vitehub")) continue
    const metadata: unknown = Reflect.get(plugin, "vitehub")
    const hasSchedules = isPlainObject(metadata) && Object.hasOwn(metadata, "schedules")
    if (!hasSchedules) continue
    const value: unknown = Reflect.get(metadata, "schedules")
    const pluginName: unknown = Reflect.get(plugin, "name")
    const contributor = isNonEmptyString(pluginName) ? pluginName : "unnamed plugin"
    const entries: unknown = value instanceof Function ? await Reflect.apply(value, undefined, [context]) : value
    if (entries === undefined && value instanceof Function) continue
    if (!Array.isArray(entries)) throw invalidContribution(contributor, "`vitehub.schedules` must be an array or return one.")
    for (const entry of entries) {
      const contribution = validateContribution(entry, contributor)
      const existing = contributions.get(contribution.name)
      if (existing && existing.definition !== contribution.definition) {
        throw duplicateScheduleError(contribution.name, describeScheduleContribution(existing), describeScheduleContribution(contribution))
      }
      if (!existing) contributions.set(contribution.name, contribution)
    }
  }
  return [...contributions.values()]
}
