import { isAbsolute, relative } from "node:path"

type VueImport = { as?: string, disabled?: boolean, from: string, name: string, type?: boolean }

export type NuxtVueImportContext = {
  getImports: () => Promise<unknown>
  getInternalContext: () => { addons: Array<{ name?: string, extendImports?: (imports: VueImport[]) => void }> }
}

type NuxtVueImports = {
  hook?: (name: "imports:context", handler: (context: NuxtVueImportContext) => Promise<void>) => void
  options: { rootDir?: string }
}

const fallbacksByApp = new WeakMap<NuxtVueImports, Map<string, string>>()

export function addNuxtVueImports(nuxt: NuxtVueImports, from: string, names: readonly string[]): void {
  let fallbacks = fallbacksByApp.get(nuxt)
  if (!fallbacks) {
    const importsByName = new Map<string, string>()
    fallbacks = importsByName
    fallbacksByApp.set(nuxt, importsByName)
    const warned = new Set<string>()
    nuxt.hook?.("imports:context", async (context) => {
      await context.getImports()
      context.getInternalContext().addons.push({
        name: "vitehub:vue-imports",
        extendImports(imports) {
          const owners = new Map(imports.filter(entry => !entry.disabled && !entry.type).map(entry => [entry.as ?? entry.name, entry.from]))
          for (const [name, fallback] of importsByName) {
            const owner = owners.get(name)
            if (owner === undefined) imports.push({ as: name, from: fallback, name })
            else if (owner !== fallback && !warned.has(name)) {
              warned.add(name)
              const source = isAbsolute(owner) ? relative(nuxt.options.rootDir || process.cwd(), owner) : owner
              console.warn(`[vitehub] ${source} already auto-imports \`${name}\`, so ViteHub does not auto-import it from ${fallback}. Import ViteHub's composable from "${fallback}" where you need it.`)
            }
          }
        },
      })
    })
  }
  for (const name of names) if (!fallbacks.has(name)) fallbacks.set(name, from)
}
