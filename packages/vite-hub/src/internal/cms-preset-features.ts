import { resolve } from "node:path"

import { usesCmsPreset } from "@vite-hub/content/vite"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { Plugin, PluginOption, UserConfig } from "vite"

interface CmsPresetFeatureOptions {
  blob?: unknown
  database?: unknown
  workspace?: unknown
}

type CmsPresetConfig = UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }

/** Options whose `cms` preset features a framework integration already resolved, for example Nuxt with a known root. */
const resolvedFeatureOptions = new WeakSet<object>()

/** The features that the Content `cms` preset needs. `vitehub()` turns on the ones left unset. */
function withCmsPresetFeatures<T extends CmsPresetFeatureOptions>(options: T): T {
  return { ...options, blob: options.blob ?? true, database: options.database ?? true, workspace: options.workspace ?? true }
}

/** Whether `vitehub()` can leave a `cms` preset feature unset for these options. */
function hasUnsetCmsPresetFeature(options: CmsPresetFeatureOptions): boolean {
  return options.blob === undefined || options.database === undefined || options.workspace === undefined
}

/**
 * Turn on the `cms` preset features for a known project root, as the Nuxt module does before it installs features.
 * Pass the final options to `markCmsPresetFeaturesResolved()` so `vitehub()` builds one plugin list.
 */
export function resolveCmsPresetFeatures<T extends CmsPresetFeatureOptions>(options: T, project: { projectRoot: string, serverDirs?: string[] }): T {
  return hasUnsetCmsPresetFeature(options) && usesCmsPreset(project) ? withCmsPresetFeatures(options) : options
}

/** Marks options whose `cms` preset features are resolved, so `vitehub()` does not resolve them again. */
export function markCmsPresetFeaturesResolved<T extends CmsPresetFeatureOptions>(options: T): T {
  resolvedFeatureOptions.add(options)
  return options
}

function selectsCmsPreset(config: CmsPresetConfig): boolean {
  const projectRoot = config[VITEHUB_PROJECT_ROOT]
    ? resolve(config[VITEHUB_PROJECT_ROOT])
    : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
  return usesCmsPreset({ projectRoot, serverDirs: config[VITEHUB_SERVER_DIRS] })
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
 * Builds the plugin list for `options`. When `database`, `blob`, or `workspace` is unset, the Content `cms` preset in
 * `server/content.ts` turns it on. The project root is known only once Vite filters plugins, so each plugin that both
 * cases share becomes one plugin that reads from the matching instance, and plugins of only one case get an `apply`
 * that keeps them for that case. An explicit `false` is never overridden.
 */
export function withCmsPresetPlugins<T extends CmsPresetFeatureOptions>(options: T, create: (options: T) => PluginOption[]): PluginOption[] {
  if (resolvedFeatureOptions.has(options) || !hasUnsetCmsPresetFeature(options)) return create(options)
  let cmsPlugins: unknown[]
  try {
    cmsPlugins = flattenPluginOptions(create(withCmsPresetFeatures(options)), [])
  }
  catch (error) {
    // An invalid combination with the preset's features fails only in apps that use the preset.
    cmsPlugins = [{ name: "vite-hub/cms-preset-features", apply: () => { throw error } }]
  }
  // Built last, so it reports invalid options as before and is the latest instance of each integration.
  const plain = flattenPluginOptions(create(options), [])
  const selection = { cms: false }
  const plainByKey = new Map<string, Plugin>()
  const plainSeen = new Map<string, number>()
  for (const option of plain) if (isPluginObject(option)) plainByKey.set(pluginKey(option, plainSeen), option)
  const pairs = new Map<Plugin, Plugin>()
  const cmsSeen = new Map<string, number>()
  for (const option of cmsPlugins) {
    if (!isPluginObject(option)) continue
    const match = plainByKey.get(pluginKey(option, cmsSeen))
    if (match) pairs.set(match, option)
  }
  const paired = new Set(pairs.values())

  // Keep the order of both lists: each shared plugin is preceded by the plugins of either case that came before it.
  const merged: unknown[] = []
  let cmsIndex = 0
  const flushCms = (until?: Plugin) => {
    while (cmsIndex < cmsPlugins.length && cmsPlugins[cmsIndex] !== until) {
      const option = cmsPlugins[cmsIndex++]
      if (!isPluginObject(option) || !paired.has(option)) merged.push(applyWhen(option, selectsCmsPreset))
    }
    if (until) cmsIndex++
  }
  for (const option of plain) {
    const cms = isPluginObject(option) ? pairs.get(option) : undefined
    if (!cms || !isPluginObject(option)) {
      merged.push(applyWhen(option, config => !selectsCmsPreset(config)))
      continue
    }
    flushCms(cms)
    merged.push(option === cms ? option : switchPlugin(option, cms, selection, selectsCmsPreset))
  }
  flushCms()
  // SAFETY: The merged list holds the Vite plugin options of both cases.
  return merged as PluginOption[]
}
