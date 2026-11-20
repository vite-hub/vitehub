import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"

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

interface ExportNode {
  type: string
  declaration?: { type: string, id?: { name: string } | null, declarations?: { id: { type: string, name?: string } }[] } | null
  exported?: { type: string, name?: string, value?: unknown } | null
  specifiers?: { exported: { type: string, name?: string, value?: unknown } }[]
}

function exportName(node: { type: string, name?: string, value?: unknown }): string {
  return node.type === "Identifier" ? node.name! : String(node.value)
}

/** Every name that the final entry code exports, including the exports that other plugins append as text. */
function entryExportNames(program: { body: ExportNode[] }): Set<string> {
  const names = new Set<string>()
  for (const node of program.body) {
    if (node.type === "ExportDefaultDeclaration") names.add("default")
    if (node.type === "ExportAllDeclaration" && node.exported) names.add(exportName(node.exported))
    if (node.type !== "ExportNamedDeclaration") continue
    for (const specifier of node.specifiers ?? []) names.add(exportName(specifier.exported))
    if (node.declaration?.id) names.add(node.declaration.id.name)
    for (const declarator of node.declaration?.declarations ?? []) {
      if (declarator.id.type === "Identifier" && declarator.id.name) names.add(declarator.id.name)
    }
  }
  return names
}

function exportSpecifier(name: string): string {
  return /^[A-Z_$][\w$]*$/i.test(name) ? name : JSON.stringify(name)
}

/**
 * Adds the named exports of `server/cloudflare.ts` to the Worker entry. Cloudflare finds Durable Object, Workflow, and
 * `WorkerEntrypoint` classes only among the exports of the entry module.
 */
function cloudflareEntryExportsPlugin(serverDirs: () => readonly string[]): Plugin {
  let file: string | undefined
  let reference: string | undefined
  return {
    name: pluginName,
    // ViteHub and Nuxt set Nitro's server directories after the modules run, so the lookup waits for the build.
    buildStart() {
      file = findCloudflareEntryExportsFile(serverDirs())
      reference = file ? this.emitFile({ fileName: chunkFileName, id: file, preserveSignature: "strict", type: "chunk" }) : undefined
    },
    // Runs after every renderChunk hook, so the entry already has the exports that other plugins append, and the emitted
    // chunk lists its final export names, also for `export *`.
    generateBundle(_options, bundle) {
      const exportsChunk = reference ? bundle[this.getFileName(reference)] : undefined
      const entry = Object.values(bundle).find(output => output.type === "chunk" && output.isEntry && /^index\.m?js$/.test(output.fileName))
      if (!file || exportsChunk?.type !== "chunk" || entry?.type !== "chunk") return
      const names = exportsChunk.exports
      const taken = entryExportNames(this.parse(entry.code) as unknown as { body: ExportNode[] })
      const conflicts = names.filter(name => name === "default" || taken.has(name))
      if (conflicts.length) throw viteHubErrorDiagnostics.VITE_HUB_CLOUDFLARE_EXPORT_CONFLICT({ file, names: conflicts.join(", ") })
      if (!names.length) return
      const path = relative(dirname(entry.fileName), exportsChunk.fileName)
      entry.code += `\nexport { ${names.map(exportSpecifier).join(", ")} } from ${JSON.stringify(path.startsWith(".") ? path : `./${path}`)}\n`
    },
  }
}

interface NitroModuleTarget {
  options: { preset?: unknown, rollupConfig?: { plugins?: unknown } & Record<string, unknown>, scanDirs: string[] }
}

/**
 * A Nitro module that adds the export plugin to the Worker build. It reads Nitro's resolved server directories, so it
 * follows `serverDir` from `nitro.config.ts` and Nuxt layers, and it skips the prerender build, which runs on Node.
 */
export function cloudflareEntryExportsModule(nitro: NitroModuleTarget): void {
  if (nitro.options.preset === "nitro-prerender") return
  const rollupConfig = nitro.options.rollupConfig ??= {}
  const plugins = rollupConfig.plugins
  const list: unknown[] = Array.isArray(plugins) ? plugins : plugins ? [plugins] : []
  if (list.some(plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === pluginName)) return
  rollupConfig.plugins = [...list, cloudflareEntryExportsPlugin(() => nitro.options.scanDirs)]
}
