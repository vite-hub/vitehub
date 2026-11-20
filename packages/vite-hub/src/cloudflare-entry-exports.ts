import { existsSync } from "node:fs"
import { join } from "node:path"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

import type { Plugin } from "vite"

const pluginName = "vite-hub/cloudflare-entry-exports"
const chunkFileName = "app-cloudflare-exports.mjs"
const extensions = [".ts", ".mts", ".js", ".mjs"]

/** The first `cloudflare` module in the server directories. The app's directory comes first, so it wins over a layer's. */
export function findCloudflareEntryExportsFile(serverDirs: readonly string[]): string | undefined {
  for (const dir of serverDirs) {
    for (const extension of extensions) {
      const file = join(dir, `cloudflare${extension}`)
      if (existsSync(file)) return file
    }
  }
}

/**
 * Adds the named exports of `server/cloudflare.ts` to the Worker entry. Cloudflare finds Durable Object, Workflow, and
 * `WorkerEntrypoint` classes only among the exports of the entry module.
 */
function cloudflareEntryExportsPlugin(file: string): Plugin {
  return {
    name: pluginName,
    buildStart() {
      this.emitFile({ fileName: chunkFileName, id: file, type: "chunk" })
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry || (chunk.fileName !== "index.mjs" && chunk.fileName !== "index.js")) return null
      const names = this.getModuleInfo(file)?.exports ?? []
      const taken = new Set(chunk.exports)
      const conflicts = names.filter(name => name === "default" || taken.has(name))
      if (conflicts.length) throw viteHubErrorDiagnostics.VITE_HUB_CLOUDFLARE_EXPORT_CONFLICT({ file, names: conflicts.join(", ") })
      if (!names.length) return null
      return { code: `${code}\nexport { ${names.join(", ")} } from "./${chunkFileName}"\n`, map: null }
    },
  }
}

/** Adds the export plugin to the Nitro bundler config once, when one of the server directories has the file. */
export function installCloudflareEntryExports(nitro: Record<string, unknown>, serverDirs: readonly string[]): void {
  const file = findCloudflareEntryExportsFile(serverDirs)
  if (!file) return
  const rollupConfig = { ...nitro.rollupConfig as Record<string, unknown> | undefined }
  const plugins: unknown[] = Array.isArray(rollupConfig.plugins) ? [...rollupConfig.plugins] : rollupConfig.plugins ? [rollupConfig.plugins] : []
  if (plugins.some(plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === pluginName)) return
  rollupConfig.plugins = [...plugins, cloudflareEntryExportsPlugin(file)]
  nitro.rollupConfig = rollupConfig
}
