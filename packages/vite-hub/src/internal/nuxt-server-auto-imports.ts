import { createRequire } from "node:module"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createUnimport, resolveBuiltinPresets, scanDirExports, type Import, type UnimportOptions } from "unimport"
import type { createIsIgnored } from "nuxt/kit"

type ImportOptions = Pick<UnimportOptions, "imports" | "presets"> & { autoImport?: boolean, dirs?: string[] }
type Nuxt = NonNullable<Parameters<typeof createIsIgnored>[0]>

function nameOf(entry: Import): string {
  return entry.as ?? entry.name
}

async function serverIgnoreFilter(nuxt: Nuxt) {
  const require = createRequire(join(nuxt.options.rootDir, "package.json"))
  const url = pathToFileURL(require.resolve("nuxt/kit")).href
  // SAFETY: The app's installed Nuxt Kit provides the ignore filter used by its server importer.
  const kit = await import(url) as { createIsIgnored: typeof createIsIgnored }
  return kit.createIsIgnored(nuxt)
}

export function installNuxtServerAutoImports(nuxt: Nuxt, entries: readonly Import[]): void {
  const { rootDir, srcDir, _layers } = nuxt.options
  const warned = new Set<string>()
  const fallbacks: Import[] = entries.map(entry => ({ ...entry }))
  const layerPriorities = (_layers ?? []).map((layer, index, layers) => ({ dir: layer.config.rootDir, priority: layers.length - index }))
    .sort((left, right) => right.dir.length - left.dir.length)
  let refresh: ((path: string) => Promise<void>) | undefined

  nuxt.hook("builder:watch", async (event, path) => {
    if (event === "add" || event === "unlink") await refresh?.(resolve(srcDir, path))
  })
  nuxt.hook("modules:done", () => {
    nuxt.hook("nitro:config", async (config: { imports?: false | ImportOptions }) => {
      const options = config.imports
      refresh = undefined
      if (!options || options.autoImport === false) return
      const imports = options.imports ??= []
      const names = new Set(fallbacks.map(nameOf))
      const presets = await resolveBuiltinPresets(options.presets ?? [])
      const dirs = options.dirs ?? []
      const roots = dirs.map(dir => dir.replace(/\/[^/]*[*{].*$/, ""))
      const isIgnored = dirs.length ? await serverIgnoreFilter(nuxt) : undefined

      async function update() {
        const scanned = await scanDirExports(dirs, { fileFilter: file => !isIgnored?.(file) })
        for (const entry of scanned) {
          entry.priority ??= layerPriorities.find(({ dir }) => entry.from === dir || entry.from.startsWith(`${dir}/`))?.priority
        }
        const competitors = [...presets, ...imports.filter(entry => !fallbacks.includes(entry)), ...scanned]
          .filter(entry => !entry.disabled && names.has(nameOf(entry)))
        const effective = await createUnimport({ imports: competitors.map(entry => ({ ...entry })), warn: () => {} }).getImports()
        const owners = new Map(effective.filter(entry => !entry.type).map(entry => [nameOf(entry), entry.from]))
        for (const fallback of fallbacks) {
          const name = fallback.name
          const owner = owners.get(name)
          if (owner === undefined) {
            delete fallback.disabled
            fallback.priority = competitors.some(entry => entry.type && nameOf(entry) === name) ? Infinity : -1
            continue
          }
          fallback.disabled = true
          if (owner === fallback.from) continue
          const source = isAbsolute(owner) ? relative(rootDir, owner) : owner
          const key = `${name}\0${source}`
          if (warned.has(key)) continue
          warned.add(key)
          console.warn(`[vitehub] ${source} already auto-imports \`${name}\` in server code, so ViteHub does not auto-import it from ${fallback.from}. Import ViteHub's helper from "${fallback.from}" where you need it.`)
        }
      }

      await update()
      for (const fallback of fallbacks) if (!imports.includes(fallback)) imports.push(fallback)
      refresh = async (path) => {
        if (roots.some(dir => path === dir || path.startsWith(`${dir}/`))) await update()
      }
    })
  })
}
