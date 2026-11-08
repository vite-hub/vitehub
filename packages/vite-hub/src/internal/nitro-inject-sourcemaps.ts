import { isPlainObject as isRecord } from "@vite-hub/internal/object"

type TransformHook = (this: unknown, code: string, ...args: unknown[]) => unknown

type RollupBeforeNitro = {
  hooks: { hook: (name: "rollup:before", callback: (nitro: unknown, config: { plugins?: unknown }) => void) => void }
}

export const nitroInjectSourcemapsModuleName = "vite-hub/nitro-inject-sourcemaps"

/**
 * Nitro 2's `@rollup/plugin-inject` returns a full-resolution sourcemap for each module that names an injected global,
 * also when it injects nothing. A Rollup watch rebuild decodes the maps of every cached module and keeps the previous
 * cache, so with ViteHub's packages inlined in development one rebuild holds gigabytes of maps and `nuxt dev` runs out
 * of heap. A module that the plugin did not change needs no map, and `map: null` tells Rollup to keep the chain as is.
 */
export function dropUnchangedInjectSourcemaps(plugins: unknown): void {
  for (const plugin of [plugins].flat(Infinity)) {
    if (!isRecord(plugin) || plugin.name !== "inject" || typeof plugin.transform !== "function") continue
    // SAFETY: Rollup calls `transform` with the module code first; the type check above proves it is a function.
    const transform = plugin.transform as TransformHook
    plugin.transform = async function (this: unknown, code: string, ...args: unknown[]) {
      const result = await transform.call(this, code, ...args)
      return isRecord(result) && result.code === code ? { ...result, map: null } : result
    }
  }
}

/** A Nitro 2 module that applies {@link dropUnchangedInjectSourcemaps} to the Rollup config Nitro builds. */
export const nitroInjectSourcemapsModule = {
  name: nitroInjectSourcemapsModuleName,
  setup(nitro: RollupBeforeNitro) {
    nitro.hooks.hook("rollup:before", (_nitro, config) => dropUnchangedInjectSourcemaps(config.plugins))
  },
}
