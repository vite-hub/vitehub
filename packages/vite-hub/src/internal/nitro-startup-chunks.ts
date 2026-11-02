import type { Plugin } from "vite"

// The package test and the chunk names of Nitro's own `node_modules` group.
const nodeModules = /node_modules[/\\](?!(?:nitro|nitro-nightly)[/\\])[^.]/
const packageName = /.*[/\\]node_modules[/\\](?<name>@[^/\\]+[/\\][^/\\]+|[^/\\.][^/\\]*)/

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function libChunkName(id: string): string | null {
  const name = packageName.exec(id)?.groups?.name
  if (!name) return null
  return `_libs/${name.endsWith("-nightly") ? name.slice(0, -8) : name}`
}

/**
 * Nitro gives each package in `node_modules` its own chunk, and Rolldown puts the dependencies of a captured module in
 * the same chunk. So a package that the server loads only on demand can take a package that the server needs at
 * startup into its chunk. The Discord Chat adapter took `chat` and `ws`, and every server start loaded discord.js.
 * This group runs before the Nitro group and gives the packages that the server imports at startup their own chunks.
 * The other packages keep the Nitro chunks and load only when the server imports them.
 * Nitro fixes this itself after 3.0.261029-rc (nitrojs/nitro#4967). Remove this plugin with that Nitro upgrade.
 */
export function nitroStartupChunks(): Plugin {
  return {
    name: "vite-hub/nitro-startup-chunks",
    apply: "build",
    config(config) {
      // Nuxt replays this hook and keeps the returned `nitro` key as the whole Nitro config, so extend it in place.
      const host = config as { nitro?: unknown }
      const nitro = cloneRecord(host.nitro)
      const rolldownConfig = cloneRecord(nitro.rolldownConfig)
      const output = cloneRecord(rolldownConfig.output)
      if (output.codeSplitting === false) return
      const codeSplitting = cloneRecord(output.codeSplitting)
      const groups = Array.isArray(codeSplitting.groups) ? codeSplitting.groups : []
      const group = { name: libChunkName, priority: 1, tags: ["$initial"], test: nodeModules }
      host.nitro = {
        ...nitro,
        rolldownConfig: { ...rolldownConfig, output: { ...output, codeSplitting: { ...codeSplitting, groups: [...groups, group] } } },
      }
    },
  }
}
