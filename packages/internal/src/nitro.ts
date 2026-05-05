import { resolveModulePath } from "exsolve"

export function resolveRuntimeEntry(
  srcRelative: string,
  packageSubpath: string,
  importMetaUrl: string,
): string {
  const fromSource = resolveModulePath(srcRelative, {
    extensions: [".ts", ".mts"],
    from: importMetaUrl,
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    extensions: [".js", ".mjs"],
    from: importMetaUrl,
  })
}

export interface NitroImportPreset { from?: string, imports?: string[] }
export interface NitroImportsLike { presets?: unknown[] }
export interface NitroModulesLike { modules?: unknown[] }
export interface NitroWithVitePlugins { options: object }
export interface VitePluginsLike { plugins?: unknown }

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function"
}

export async function hasNamedVitePlugin(plugin: unknown, name: string): Promise<boolean> {
  if (isPromiseLike(plugin)) {
    return hasNamedVitePlugin(await plugin, name)
  }

  if (Array.isArray(plugin)) {
    for (const entry of plugin) {
      if (await hasNamedVitePlugin(entry, name)) {
        return true
      }
    }
    return false
  }

  return typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === name
}

export function hasNitroModule(entry: unknown, moduleId: string, moduleName: string): boolean {
  if (entry === moduleId) {
    return true
  }

  if (typeof entry !== "object" || entry === null) {
    return false
  }

  const module = "nitro" in entry ? entry.nitro : entry
  return typeof module === "object" && module !== null && "name" in module && module.name === moduleName
}

export async function assertNoVitePlugin(vite: VitePluginsLike | undefined, vitePluginName: string, integrationName: string): Promise<void> {
  if (await hasNamedVitePlugin(vite?.plugins, vitePluginName)) {
    throw new Error(`[vitehub] Do not configure ${vitePluginName} when using ${integrationName}.`)
  }
}

export async function assertNoVitePluginInNitro(nitro: NitroWithVitePlugins, vitePluginName: string, integrationName: string): Promise<void> {
  await assertNoVitePlugin((nitro.options as { vite?: VitePluginsLike }).vite, vitePluginName, integrationName)
}

export function assertNoNitroModule(nitro: NitroModulesLike, moduleId: string, moduleName: string, integrationName: string): void {
  if (nitro.modules?.some(entry => hasNitroModule(entry, moduleId, moduleName))) {
    throw new Error(`[vitehub] Do not configure ${moduleId} when using ${integrationName}.`)
  }
}

export function mergeNitroImportsPreset<T extends NitroImportsLike | false | undefined>(
  current: T,
  preset: { from: string, imports: string[] },
): T extends false ? false : NitroImportsLike {
  if (current === false) {
    return current as never
  }

  const existing = (current || {}) as NitroImportsLike
  const presets = (Array.isArray(existing.presets) ? [...existing.presets] : []) as NitroImportPreset[]
  const found = presets.find(entry => entry?.from === preset.from)

  if (found && Array.isArray(found.imports)) {
    const seen = new Set(found.imports)
    found.imports.push(...preset.imports.filter(name => !seen.has(name)))
  }
  else if (!found) {
    presets.push({ from: preset.from, imports: [...preset.imports] })
  }

  return { ...existing, presets } as never
}
