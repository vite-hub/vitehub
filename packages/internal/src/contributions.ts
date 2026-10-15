import { fileURLToPath } from "node:url"

import { isAbsolute } from "pathe"

import { isPlainObject } from "./object.ts"

/** Module and export that hold a contributed Definition. */
export interface ContributionDefinition {
  /**
   * Absolute file path, `file:` URL, or package specifier that the application can import. Relative paths are
   * rejected because they have no stable base.
   */
  module: string
  /** Named export that holds the Definition. Defaults to `default`. */
  export?: string
}

/**
 * One Definition that a Vite plugin adds to a Server Primitive, for example a Workspace, a Schedule, or Database tables.
 * Every owner package reads this shape from `plugin.vitehub.<key>`. Owners can add fields, such as `database`.
 */
export interface Contribution {
  /** Unique name in the owner, for example the Workspace or Schedule name. */
  name: string
  definition: ContributionDefinition
  /** Why the plugin adds the Definition. `vitehub inspect` and the Console show it. */
  reason?: string
}

/** Roots that ViteHub passes to every contribution factory. */
export interface ContributionContext {
  /** Vite root. */
  root: string
  /** ViteHub project root. It can differ from the Vite root, for example in a Nuxt app with a `srcDir`. */
  projectRoot: string
  /** Server directories that the host forwards, for example Nuxt's `serverDir` and the server directories of layers. */
  serverDirs?: readonly string[]
}

/**
 * Returns the contributions of a plugin. It runs once per discovery pass, so it must be idempotent and must not depend
 * on the order of Vite config hooks.
 */
export type ContributionFactory<TEntry extends Contribution = Contribution> = (context: ContributionContext) =>
  | readonly TEntry[]
  | undefined
  | Promise<readonly TEntry[] | undefined>

export type ContributionSource<TEntry extends Contribution = Contribution> = readonly TEntry[] | ContributionFactory<TEntry>

/** A Vite plugin that contributes Definitions under `vitehub[TKey]`. */
export type ContributingPlugin<TKey extends string, TEntry extends Contribution = Contribution> = {
  name?: string
  vitehub?: { [K in TKey]?: ContributionSource<TEntry> }
}

/** A validated contribution with its export resolved and the name of the plugin that added it. */
export interface CollectedContribution {
  name: string
  definition: { module: string, export: string }
  reason?: string
  /** Name of the contributing Vite plugin. */
  plugin: string
}

export interface CollectContributionsOptions<TFields extends object> {
  /** Key under `plugin.vitehub`, for example `workspaces`. */
  key: string
  /** Definition kind in messages, for example `Workspace`. */
  kind: string
  context: ContributionContext
  /** Owner diagnostic for an invalid entry. */
  invalid: (message: string) => Error
  /** Owner diagnostic for one name from two contributions. */
  duplicate: (message: string) => Error
  /** Returns why a name is invalid, or `undefined` when the owner accepts it. */
  checkName?: (name: string) => string | undefined
  /** Reads owner fields from the raw entry. Call `fail(reason)` to reject the entry. */
  fields?: (entry: Readonly<Record<string, unknown>>, fail: (reason: string) => never) => TFields
}

type NoFields = Record<never, never>

const unnamedPlugin = "unnamed plugin"

function isNonEmptyString(value: unknown): value is string {
  return String(value) === value && value.length > 0
}

function isThenable(value: Record<string, unknown>): value is Record<string, unknown> & PromiseLike<unknown> {
  return value.then instanceof Function
}

async function flattenPlugins(value: unknown, plugins: object[], seen: Set<unknown>): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) await flattenPlugins(item, plugins, seen)
    return
  }
  if (!isPlainObject(value) || seen.has(value)) return
  seen.add(value)
  // Vite accepts promised plugin options. The `config` hook sees them unresolved.
  if (isThenable(value)) {
    await flattenPlugins(await value, plugins, seen)
    return
  }
  plugins.push(value)
}

function readModule(value: string): string {
  return value.startsWith("file:") ? fileURLToPath(value) : value
}

function isRelative(module: string): boolean {
  return !isAbsolute(module) && /^\.\.?(?:[\\/]|$)/.test(module)
}

/** Describes a contribution as `module#export from plugin "name"` for messages. */
export function describeContribution(contribution: Pick<CollectedContribution, "definition" | "plugin">): string {
  const { export: exportName, module } = contribution.definition
  return `${exportName === "default" ? module : `${module}#${exportName}`} from plugin ${JSON.stringify(contribution.plugin)}`
}

/**
 * Collects `plugin.vitehub[key]` contributions from Vite plugins. It accepts nested and promised plugin options, runs
 * factories in plugin order, and returns the contributions sorted by name. One plugin that is registered twice with
 * the same entry adds it once. Two contributions with one name fail with `duplicate`, which names both plugins.
 */
export async function collectContributions(
  plugins: readonly unknown[] | undefined,
  options: CollectContributionsOptions<NoFields> & { fields?: undefined },
): Promise<CollectedContribution[]>
export async function collectContributions<TFields extends object>(
  plugins: readonly unknown[] | undefined,
  options: CollectContributionsOptions<TFields> & { fields: NonNullable<CollectContributionsOptions<TFields>["fields"]> },
): Promise<Array<CollectedContribution & TFields>>
export async function collectContributions(
  plugins: readonly unknown[] | undefined,
  options: CollectContributionsOptions<object>,
): Promise<CollectedContribution[]> {
  const candidates: object[] = []
  await flattenPlugins(plugins ?? [], candidates, new Set())
  const collected = new Map<string, { contribution: CollectedContribution, identity: string }>()

  for (const plugin of candidates) {
    if (!Object.hasOwn(plugin, "vitehub")) continue
    const metadata: unknown = Reflect.get(plugin, "vitehub")
    if (!isPlainObject(metadata) || !Object.hasOwn(metadata, options.key)) continue
    const source = metadata[options.key]
    const pluginName: unknown = Reflect.get(plugin, "name")
    const contributor = isNonEmptyString(pluginName) ? pluginName : unnamedPlugin
    const fail: (reason: string) => never = (reason) => {
      throw options.invalid(`[vitehub] Plugin ${JSON.stringify(contributor)} contributed an invalid ${options.kind}: ${reason}`)
    }
    const entries: unknown = source instanceof Function ? await Reflect.apply(source, undefined, [options.context]) : source
    if (entries === undefined && source instanceof Function) continue
    if (!Array.isArray(entries)) fail(`\`vitehub.${options.key}\` must be an array or a function that returns one.`)

    const list: readonly unknown[] = entries
    for (const entry of list) {
      const contribution = readContribution(entry, contributor, options, fail)
      const identity = JSON.stringify(contribution)
      const existing = collected.get(contribution.name)
      if (existing?.identity === identity) continue
      if (existing) {
        throw options.duplicate(`[vitehub] ${options.kind} ${JSON.stringify(contribution.name)} is contributed more than once:\n  - ${describeContribution(existing.contribution)}\n  - ${describeContribution(contribution)}\nEach ${options.kind} name must have one contribution. Rename or remove one.`)
      }
      collected.set(contribution.name, { contribution, identity })
    }
  }

  return [...collected.values()]
    .map(({ contribution }) => contribution)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

function readContribution(
  entry: unknown,
  plugin: string,
  options: CollectContributionsOptions<object>,
  fail: (reason: string) => never,
): CollectedContribution {
  if (!isPlainObject(entry)) return fail("expected { name, definition: { module, export? }, reason? }.")
  const { definition, name, reason } = entry
  if (!isNonEmptyString(name) || name.trim() !== name) return fail("`name` must be a non-empty string without surrounding whitespace.")
  const nameProblem = options.checkName?.(name)
  if (nameProblem) return fail(`${options.kind} ${JSON.stringify(name)}: ${nameProblem}`)
  if (!isPlainObject(definition)) return fail(`${options.kind} ${JSON.stringify(name)} needs \`definition: { module, export? }\`.`)
  if (!isNonEmptyString(definition.module)) return fail(`\`definition.module\` of ${options.kind} ${JSON.stringify(name)} must be a non-empty string.`)
  const module = readModule(definition.module)
  if (isRelative(module)) {
    return fail(`\`definition.module\` of ${options.kind} ${JSON.stringify(name)} is relative: ${JSON.stringify(module)}. Use an absolute file path, a file: URL, or a package specifier.`)
  }
  const exportName = definition.export ?? "default"
  if (!isNonEmptyString(exportName)) return fail(`\`definition.export\` of ${options.kind} ${JSON.stringify(name)} must be a non-empty string.`)
  if (reason !== undefined && !isNonEmptyString(reason)) return fail(`\`reason\` of ${options.kind} ${JSON.stringify(name)} must be a non-empty string.`)

  const base: CollectedContribution = { definition: { export: exportName, module }, name, plugin }
  if (reason !== undefined) base.reason = reason
  // Owner fields cannot replace the shared fields.
  const fields = options.fields?.(entry, fail)
  return { ...fields, ...base }
}
