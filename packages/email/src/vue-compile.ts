import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { isRecord } from "@vite-hub/internal/object"

import { emailErrorDiagnostics } from "./error-diagnostics.ts"

import type { InlineConfig, Plugin } from "vite"
import type { EmailTemplate } from "./templates.ts"

/** The options of the host's `@vitejs/plugin-vue` that also apply to Email templates. */
export type EmailVuePluginOptions = Record<string, unknown>

const entryPrefix = "\0vitehub-email-vue:"
const vueImport = /^(?:vue|@vue\/[^/]+)(?:\/|$)/
const hostPluginOptionKeys = ["compiler", "customElement", "exclude", "features", "include", "script", "style", "template"]

/** The file name of a compiled Email template: a flat name that a bundler and a Node `import()` read the same way. */
export const emailTemplateFileName = (name: string): string => encodeURIComponent(name).replaceAll("~", "%7E").replaceAll("%", "~")

export const isVueEmailTemplate = (template: EmailTemplate): boolean => template.file.endsWith(".vue")

async function findPackage(from: string, name: string): Promise<string | undefined> {
  let directory = await realpath(from).catch(() => from)
  while (true) {
    const manifest = join(directory, "node_modules", name, "package.json")
    if (await stat(manifest).then(entry => entry.isFile(), () => false)) return await realpath(manifest)
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

async function importPackage(packageJson: string): Promise<Record<string, unknown>> {
  const manifest: unknown = JSON.parse(await readFile(packageJson, "utf8"))
  const root = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports["."] : undefined
  const conditions = isRecord(root) && isRecord(root.import) ? root.import : root
  const entry = typeof conditions === "string" ? conditions : isRecord(conditions) && typeof conditions.default === "string" ? conditions.default : undefined
  if (!entry) return {}
  const module: unknown = await import(pathToFileURL(resolve(dirname(packageJson), entry)).href)
  return isRecord(module) ? module : {}
}

async function findPluginVuePackage(projectRoot: string): Promise<string | undefined> {
  const direct = await findPackage(projectRoot, "@vitejs/plugin-vue")
  if (direct) return direct
  const nuxt = await findPackage(projectRoot, "nuxt")
  const viteBuilder = nuxt && await findPackage(dirname(nuxt), "@nuxt/vite-builder")
  return viteBuilder && await findPackage(dirname(viteBuilder), "@vitejs/plugin-vue")
}

function resolveVueRenderImport(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  return fileURLToPath(new URL(`./runtime/vue-render.${extension}`, import.meta.url))
}

/** The plugin options of the host's `@vitejs/plugin-vue` that compile templates the same way. */
export function hostVuePluginOptions(plugins: readonly Plugin[]): EmailVuePluginOptions | undefined {
  const plugin = plugins.find(entry => entry.name === "vite:vue")
  if (!plugin) return
  const options: unknown = isRecord(plugin.api) ? plugin.api.options : undefined
  return isRecord(options) ? Object.fromEntries(hostPluginOptionKeys.filter(key => options[key] !== undefined).map(key => [key, options[key]])) : {}
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

/**
 * Compiles each Vue Email template into one module in `outputRoot` with the app's `@vitejs/plugin-vue`. The module
 * renders the template with `vue/server-renderer`. `vue` and the render runtime stay imports, so the template and the
 * app use one Vue and one HTML parser.
 * Returns the source files that the templates import.
 */
export async function compileEmailVueTemplates(templates: EmailTemplate[], outputRoot: string, projectRoot: string, pluginOptions: EmailVuePluginOptions = {}): Promise<string[]> {
  if (!templates.length) return []
  const file = relative(projectRoot, templates[0]!.file)
  if (!await findPackage(projectRoot, "vue")) throw emailErrorDiagnostics.EMAIL_VUE_MISSING({ file })
  const pluginVuePackage = await findPluginVuePackage(projectRoot)
  const vitePackage = pluginVuePackage && await findPackage(dirname(pluginVuePackage), "vite")
  if (!pluginVuePackage || !vitePackage) throw emailErrorDiagnostics.EMAIL_VUE_PLUGIN_MISSING({ file })
  const [pluginVue, vite] = await Promise.all([importPackage(pluginVuePackage), importPackage(vitePackage)])
  if (typeof pluginVue.default !== "function" || typeof vite.build !== "function") throw emailErrorDiagnostics.EMAIL_VUE_PLUGIN_MISSING({ file })
  // SAFETY: the default export of `@vitejs/plugin-vue` is its plugin factory, and the check above proves it is a function.
  const vue = pluginVue.default as (options?: EmailVuePluginOptions) => Plugin
  // SAFETY: `build` of the `vite` package that `@vitejs/plugin-vue` imports takes an inline config, and the check above proves it is a function.
  const build = vite.build as (config: InlineConfig) => Promise<unknown>
  const byEntry = new Map(templates.map(template => [`${entryPrefix}${template.name}`, template.file]))
  const renderImport = resolveVueRenderImport()
  const entries: Plugin = {
    name: "vitehub:email-vue-templates",
    enforce: "pre",
    resolveId: id => byEntry.has(id) ? id : undefined,
    load(id) {
      const source = byEntry.get(id)
      if (!source) return
      return [
        `import component from ${JSON.stringify(source)}`,
        `import { renderEmailVue } from ${JSON.stringify(renderImport)}`,
        "export default (data) => renderEmailVue(component, data)",
        "",
      ].join("\n")
    },
  }
  const watched = new Set<string>()
  const watch: Plugin = {
    name: "vitehub:email-vue-watch",
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const path = id.split("?", 1)[0]!
        if (!id.startsWith("\0") && isInside(projectRoot, path) && !path.split(/[\\/]/).includes("node_modules")) watched.add(path)
      }
    },
  }
  await build({
    configFile: false,
    envFile: false,
    logLevel: "warn",
    mode: "production",
    plugins: [entries, vue(pluginOptions), watch],
    publicDir: false,
    root: projectRoot,
    ssr: { noExternal: true, target: "node" },
    build: {
      copyPublicDir: false,
      emptyOutDir: false,
      minify: false,
      outDir: outputRoot,
      reportCompressedSize: false,
      rollupOptions: {
        external: id => id === renderImport || vueImport.test(id),
        input: Object.fromEntries(templates.map(template => [emailTemplateFileName(template.name), `${entryPrefix}${template.name}`])),
        output: { chunkFileNames: "_chunks/[name]-[hash].mjs", entryFileNames: "[name].mjs", format: "es" },
      },
      ssr: true,
      write: true,
    },
  })
  return [...watched]
}
