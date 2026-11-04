/** The Nuxt fields that the module option lookup reads. */
export interface ModuleOptionsNuxt {
  options: { modules: readonly unknown[] }
}

/** The module name: a string entry, or the `getMeta()` name of an imported module function. */
async function moduleName(module: unknown): Promise<unknown> {
  if (typeof module !== "function") return module
  const getMeta: unknown = Reflect.get(module, "getMeta")
  if (typeof getMeta !== "function") return
  const meta: unknown = await Reflect.apply(getMeta, module, [])
  return meta && typeof meta === "object" ? Reflect.get(meta, "name") : undefined
}

/**
 * The options of a Nuxt module: its config key, then the inline options of its `modules` entries, which win. Undefined
 * when neither is there. `names` are the entry names and the `getMeta()` name of the module.
 */
export async function readModuleOptions(nuxt: ModuleOptionsNuxt, names: readonly string[], configKey: string): Promise<Record<string, unknown> | undefined> {
  let installed = false
  let inline: Record<string, unknown> = {}
  for (const entry of nuxt.options.modules) {
    const [module, options] = Array.isArray(entry) ? entry : [entry, undefined]
    const name = await moduleName(module)
    if (typeof name !== "string" || !names.includes(name)) continue
    installed = true
    if (options && typeof options === "object") inline = { ...inline, ...options }
  }
  // The config key's type exists only when the module's types load.
  const configured: unknown = Reflect.get(nuxt.options, configKey)
  if (!installed && !configured) return
  return { ...(configured && typeof configured === "object" ? configured : {}), ...inline }
}

/** Inline and `vitehub` key options of `vite-hub/nuxt`, or `undefined` when the module is not installed. */
export async function viteHubModuleOptions(nuxt: ModuleOptionsNuxt): Promise<Record<string, unknown> | undefined> {
  return await readModuleOptions(nuxt, ["vite-hub/nuxt"], "vitehub")
}
