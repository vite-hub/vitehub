import { resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { parseAst } from "vite"

import { ownerModules } from "./owner-modules.ts"

import type { Plugin, PluginOption, UserConfig } from "vite"

interface CmsPresetFeatureOptions {
  blob?: unknown
  comments?: unknown
  database?: unknown
  kv?: unknown
  workspace?: unknown
}

type CmsPresetConfig = UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }

// An app without the CMS or Comments package cannot select their presets.
function cmsStore(project: { projectRoot: string, serverDirs?: readonly string[] }) {
  return ownerModules.cmsVite?.cmsStore(project)
}

function usesComments(project: { projectRoot: string, serverDirs?: readonly string[] }) {
  return ownerModules.commentsVite?.usesComments(project) ?? false
}

function usesForms(project: { projectRoot: string, serverDirs?: readonly string[] }) {
  return ownerModules.formsVite?.usesForms(project) ?? false
}

/** A `github()` Source in `server/content.ts` keeps its head commit in KV. */
function usesGitHubSources(project: { projectRoot: string, serverDirs?: readonly string[] }) {
  return ownerModules.contentVite?.usesGitHubSources(project, parseAst) ?? false
}

function projectOf(config: CmsPresetConfig): { projectRoot: string, serverDirs?: readonly string[] } {
  const projectRoot = config[VITEHUB_PROJECT_ROOT]
    ? resolve(config[VITEHUB_PROJECT_ROOT])
    : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
  return { projectRoot, serverDirs: config[VITEHUB_SERVER_DIRS] }
}

/** Options whose `cms` preset features a framework integration already resolved, for example Nuxt with a known root. */
const resolvedFeatureOptions = new WeakSet<object>()

/** The features that the `cms` preset needs. `vitehub()` turns on the ones left unset. */
function withCmsPresetFeatures<T extends CmsPresetFeatureOptions>(options: T, store: "blob-database" | "github"): T {
  return { ...options, blob: options.blob ?? (store === "blob-database" ? true : undefined), database: options.database ?? true, workspace: options.workspace ?? true }
}

/** Whether `vitehub()` can leave a `cms` preset feature unset for these options. */
function hasUnsetCmsPresetFeature(options: CmsPresetFeatureOptions): boolean {
  return options.blob === undefined || options.database === undefined || options.workspace === undefined
}

/**
 * Turn on the `cms` preset features for a known project root, as the Nuxt module does before it installs features.
 * It also turns on `kv` when it is unset and `server/content.ts` imports `github()`. Pass the final options to `markCmsPresetFeaturesResolved()` so `vitehub()` builds one plugin list.
 */
export function resolveCmsPresetFeatures<T extends CmsPresetFeatureOptions>(options: T, project: { projectRoot: string, serverDirs?: string[] }): T {
  const resolved = resolveStorageFeatures(options, project)
  // Without `@vite-hub/kv`, the app keeps no KV, and Content logs `CONTENT_R0021`.
  return resolved.kv === undefined && ownerModules.kvVite && usesGitHubSources(project) ? { ...resolved, kv: true } : resolved
}

function resolveStorageFeatures<T extends CmsPresetFeatureOptions>(options: T, project: { projectRoot: string, serverDirs?: string[] }): T {
  const store = hasUnsetCmsPresetFeature(options) ? cmsStore(project) : undefined
  if (store) return withCmsPresetFeatures(options, store)
  // Comments and Forms need the Database only.
  if (options.database !== undefined) return options
  return (options.comments !== false && (options.comments || usesComments(project))) || usesForms(project) ? { ...options, database: true } : options
}

/** Marks options whose `cms` preset features are resolved, so `vitehub()` does not resolve them again. */
export function markCmsPresetFeaturesResolved<T extends CmsPresetFeatureOptions>(options: T): T {
  resolvedFeatureOptions.add(options)
  return options
}

function selectedCmsPresetStore(config: CmsPresetConfig): "blob-database" | "github" | undefined {
  return cmsStore(projectOf(config))
}

function flattenPluginOptions(option: unknown, plugins: unknown[]): unknown[] {
  if (Array.isArray(option)) for (const item of option) flattenPluginOptions(item, plugins)
  else if (option) plugins.push(option)
  return plugins
}

function isPluginObject(option: unknown): option is Plugin {
  return Object(option) === option && !(option instanceof Function) && !(Reflect.get(Object(option), "then") instanceof Function)
}

function pluginKey(plugin: Plugin, seen: Map<string, number>): string {
  const index = seen.get(plugin.name) ?? 0
  seen.set(plugin.name, index + 1)
  return `${plugin.name}\u0000${index}`
}

function withApply(apply: Plugin["apply"], when: (config: CmsPresetConfig) => boolean): NonNullable<Plugin["apply"]> {
  return (config, env) => when(config) && (apply === undefined || (apply instanceof Function ? apply(config, env) : apply === env.command))
}

/** Gives a plugin option an `apply` that also requires `when(config)`, so Vite drops it otherwise. */
function applyWhen(option: unknown, when: (config: CmsPresetConfig) => boolean): unknown {
  if (!isPluginObject(option)) {
    return Promise.resolve(option).then(resolved => Array.isArray(resolved) ? resolved.map(item => applyWhen(item, when)) : applyWhen(resolved, when))
  }
  option.apply = withApply(option.apply, when)
  return option
}

function selectsDatabaseOwner(config: CmsPresetConfig, comments: unknown): boolean {
  const project = projectOf(config)
  // `comments: false` keeps `server/comments.ts` from turning the Database on, as `resolveCmsPresetFeatures()` does.
  return (comments !== false && usesComments(project)) || usesForms(project)
}

/**
 * One plugin that is the plain or the `cms` preset instance of the same plugin. Vite decides through `apply`, and
 * every other property reads from the chosen instance. Before Vite decides, it reads from the plain instance.
 */
function switchPlugin(plain: Plugin, cms: Plugin, selection: { cms: boolean }, selectsCms: (config: CmsPresetConfig) => boolean): Plugin {
  const pick = () => selection.cms ? cms : plain
  // SAFETY: Every own key of both instances is defined below as an accessor, and `apply` right after the loop.
  const plugin = {} as Plugin
  for (const key of new Set([...Reflect.ownKeys(plain), ...Reflect.ownKeys(cms)])) {
    if (key === "apply") continue
    Object.defineProperty(plugin, key, {
      configurable: true,
      enumerable: true,
      get: () => Reflect.get(pick(), key),
      set: value => Reflect.set(pick(), key, value),
    })
  }
  plugin.apply = (config, env) => {
    selection.cms = selectsCms(config)
    const apply = pick().apply
    return apply === undefined || (apply instanceof Function ? apply(config, env) : apply === env.command)
  }
  return plugin
}

/**
 * Merges two builds of the plugin list into one that Vite filters by `selects(config)`. `alt` is the build with more
 * features on. Each plugin that both builds share becomes one plugin that reads from the matching instance, and plugins
 * of only one build get an `apply` that keeps them for that case.
 */
function composeVariants(plain: unknown[], alt: unknown[], selects: (config: CmsPresetConfig) => boolean): unknown[] {
  const selection = { cms: false }
  const plainByKey = new Map<string, Plugin>()
  const plainSeen = new Map<string, number>()
  for (const option of plain) if (isPluginObject(option)) plainByKey.set(pluginKey(option, plainSeen), option)
  const pairs = new Map<Plugin, Plugin>()
  const altSeen = new Map<string, number>()
  for (const option of alt) {
    if (!isPluginObject(option)) continue
    const match = plainByKey.get(pluginKey(option, altSeen))
    if (match) pairs.set(match, option)
  }
  const paired = new Set(pairs.values())

  // Keep the order of both lists: each shared plugin is preceded by the plugins of either case that came before it.
  const merged: unknown[] = []
  let altIndex = 0
  const flushAlt = (until?: Plugin) => {
    while (altIndex < alt.length && alt[altIndex] !== until) {
      const option = alt[altIndex++]
      if (!isPluginObject(option) || !paired.has(option)) merged.push(applyWhen(option, selects))
    }
    if (until) altIndex++
  }
  for (const option of plain) {
    const other = isPluginObject(option) ? pairs.get(option) : undefined
    if (!other || !isPluginObject(option)) {
      merged.push(applyWhen(option, config => !selects(config)))
      continue
    }
    flushAlt(other)
    merged.push(option === other ? option : switchPlugin(option, other, selection, selects))
  }
  flushAlt()
  return merged
}

/**
 * Builds the plugin list for `options`. When `database`, `blob`, or `workspace` is unset, the `cms` preset in
 * `server/content.ts` turns it on. When `database` is unset, `server/comments.ts`, the `comments` option, or `server/forms/` turns it on.
 * When `kv` is unset, a `github()` Source in `server/content.ts` turns it on. The project root is known
 * only once Vite filters plugins, so each build of the list is merged into one that Vite filters, as `composeVariants()`
 * does. An explicit `false` is never overridden.
 */
export function withCmsPresetPlugins<T extends CmsPresetFeatureOptions>(options: T, createPlain: (options: T) => PluginOption[]): PluginOption[] {
  if (resolvedFeatureOptions.has(options)) return createPlain(options)
  const create = (variant: T) => withContentKVPlugins(variant, createPlain)
  const cmsUnset = hasUnsetCmsPresetFeature(options)
  const databaseUnset = options.database === undefined
  if (!cmsUnset && !databaseUnset) return create(options)
  const attempt = (variant: T): unknown[] | { error: unknown } => {
    try {
      return flattenPluginOptions(create(variant), [])
    }
    catch (error) {
      return { error }
    }
  }
  // An invalid combination with a variant's features fails only in apps that select it.
  const failing = (error: unknown): unknown[] => [{ name: "vite-hub/cms-preset-features", apply: () => { throw error } }]
  const blob = cmsUnset ? attempt(withCmsPresetFeatures(options, "blob-database")) : undefined
  const github = cmsUnset ? attempt(withCmsPresetFeatures(options, "github")) : undefined
  const comments = databaseUnset ? attempt({ ...options, database: true }) : undefined
  // Built last, so it reports invalid options as before and is the latest instance of each integration.
  let merged = flattenPluginOptions(create(options), [])
  if (comments) merged = composeVariants(merged, "error" in comments ? failing(comments.error) : comments, config => selectsDatabaseOwner(config, options.comments) && !(cmsUnset && selectedCmsPresetStore(config)))
  if (blob) merged = composeVariants(merged, "error" in blob ? failing(blob.error) : blob, config => selectedCmsPresetStore(config) === "blob-database")
  if (github) merged = composeVariants(merged, "error" in github ? failing(github.error) : github, config => selectedCmsPresetStore(config) === "github")
  // SAFETY: The merged list holds the Vite plugin options of every build.
  return merged as PluginOption[]
}

/**
 * Builds the plugin list for `options`, with KV on when `kv` is unset and `server/content.ts` imports `github()`. A
 * `github()` Source keeps its head commit in KV. When the list with KV fails to build, such as without `@vite-hub/kv`,
 * the app keeps no KV, and Content logs `CONTENT_R0021` and reads the branch.
 */
function withContentKVPlugins<T extends CmsPresetFeatureOptions>(options: T, create: (options: T) => PluginOption[]): PluginOption[] {
  if (options.kv !== undefined || !ownerModules.contentVite || !ownerModules.kvVite) return create(options)
  let withKV: unknown[]
  try {
    withKV = flattenPluginOptions(create({ ...options, kv: true }), [])
  }
  catch {
    return create(options)
  }
  // SAFETY: Both lists hold the Vite plugin options of this build.
  return composeVariants(flattenPluginOptions(create(options), []), withKV, config => usesGitHubSources(projectOf(config))) as PluginOption[]
}
