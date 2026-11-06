import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"

import { createNoExternalAddition, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_NITRO_MAJOR_VERSION } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { isLinguiTemplateTransform, linguiTemplateTransform } from "@lingui/vue/compiler"

import { compileCatalogs, compileCatalogModule } from "./catalogs.ts"
import { catalogPath, createLinguiConfig } from "./lingui.ts"
import { resolveI18nLocaleConfig } from "./locales.ts"
import { transformMacros } from "./macros.ts"

import type { LinguiConfigNormalized } from "@lingui/conf"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { I18nLocaleConfig, I18nOptions } from "./locales.ts"

const packageName = "@vite-hub/i18n"
const pluginName = "@vite-hub/i18n/vite"
const clientModule = "virtual:vite-hub/i18n/client"
const resolvedClientModule = `\0${clientModule}`
const generatedPlugin = ".vitehub/nitro/i18n/plugin.mjs"
const generatedMessages = ".vitehub/i18n/messages.mjs"
const mergeNoExternal = createNoExternalAddition(packageName)

const sourceRe = /\.(?:vue|[cm]?[jt]sx?)(?:\?.*)?$/
const nodeModulesRe = /[\\/]node_modules[\\/]/
const otherFormQueryRe = /[?&](?:raw|url|inline|worker|sharedworker)(?:&|=|$)|[?&]type=style(?:&|$)/

export interface I18nVitePluginOptions extends Partial<I18nOptions> {
  /** Folder that holds `locales/`. Defaults to the ViteHub project root. */
  projectRoot?: string
}

interface InternalOptions extends I18nVitePluginOptions {
  importBase?: string
}

export type I18nVitePlugin = Plugin & { vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata }

type ViteHubConfig = (UserConfig | ResolvedConfig) & { i18n?: I18nOptions, nitro?: unknown, [VITEHUB_NITRO_MAJOR_VERSION]?: 2 | 3 }

function renderNitroPlugin(importBase: string, nitroMajor: 2 | 3, messagesFile: string): string {
  const context = nitroMajor === 2
    ? `import { defineNitroPlugin as definePlugin, useEvent as current } from "nitropack/runtime"`
    : `import { definePlugin } from "nitro"\nimport { useRequest as current } from "nitro/context"`
  return [
    context,
    `import { installI18nServer } from ${JSON.stringify(`${importBase}/server`)}`,
    `import { config, messages } from ${JSON.stringify(messagesFile)}`,
    "",
    "export default definePlugin((nitroApp) => {",
    "  installI18nServer(nitroApp, {",
    "    config,",
    "    messages,",
    "    current: () => {",
    "      try { return current() }",
    "      catch { return undefined }",
    "    },",
    "  })",
    "})",
    "",
  ].join("\n")
}

function renderClientModule(importBase: string, rootDir: string, locale: I18nLocaleConfig): string {
  const loaders = locale.locales.map((entry) => {
    const file = catalogPath(rootDir, entry)
    const load = existsSync(file) ? `() => import(${JSON.stringify(file)})` : "() => Promise.resolve({ messages: {} })"
    return `    ${JSON.stringify(entry)}: ${load},`
  })
  return [
    `import { configureI18n } from ${JSON.stringify(`${importBase}/runtime`)}`,
    "",
    "configureI18n({",
    `  locales: ${JSON.stringify(locale.locales)},`,
    `  sourceLocale: ${JSON.stringify(locale.sourceLocale)},`,
    `  cookie: ${JSON.stringify(locale.cookie)},`,
    "  catalogs: {",
    ...loaders,
    "  },",
    "})",
    "",
  ].join("\n")
}

/** Vite plugin of ViteHub i18n. `vitehub({ i18n })` and `vite-hub/nuxt` add it for you. */
export function hubI18n(options: I18nVitePluginOptions = {}): I18nVitePlugin {
  const importBase = (options as InternalOptions).importBase ?? packageName
  let configured: I18nVitePluginOptions = options
  let projectRoot: string | undefined
  let locale: I18nLocaleConfig | undefined
  let lingui: LinguiConfigNormalized | undefined
  let isProduction = false

  const setup = (config: ViteHubConfig): void => {
    configured = { ...options, ...config.i18n }
    projectRoot = resolveViteHubProjectRoot(config.root || process.cwd(), { projectRoot: configured.projectRoot })
    locale = resolveI18nLocaleConfig({ locales: configured.locales ?? [], cookie: configured.cookie })
    lingui = createLinguiConfig({ rootDir: projectRoot, locale, importBase })
  }

  const writeServerFiles = async (nitroMajor: 2 | 3): Promise<void> => {
    if (!projectRoot || !locale || !lingui) return
    const messagesFile = resolve(projectRoot, generatedMessages)
    const messages = await compileCatalogs(lingui)
    await writeFileIfChanged(messagesFile, [
      `export const config = ${JSON.stringify({ ...locale, catalogs: {} })}`,
      `export const messages = ${JSON.stringify(messages)}`,
      "",
    ].join("\n"))
    await writeFileIfChanged(resolve(projectRoot, generatedPlugin), renderNitroPlugin(importBase, nitroMajor, messagesFile))
  }

  // The CLI can run before Vite resolves the config, so it builds the config from the plugin options.
  const resolveLingui = (rootDir: string): LinguiConfigNormalized => lingui ?? createLinguiConfig({
    rootDir: resolveViteHubProjectRoot(rootDir, { projectRoot: configured.projectRoot }),
    locale: resolveI18nLocaleConfig({ locales: configured.locales ?? [], cookie: configured.cookie }),
    importBase,
  })

  const inspectionRoot = (): string => projectRoot ?? resolveViteHubProjectRoot(process.cwd(), { projectRoot: configured.projectRoot })

  return {
    name: pluginName,
    enforce: "post",
    vitehub: {
      cli: async () => {
        const { createI18nCliContributor } = await import("./cli.ts")
        return createI18nCliContributor(resolveLingui)
      },
      inspect: () => ({
        definitions: [{
          kind: "i18n",
          label: "Locales",
          list: async () => {
            const { inspectI18n } = await import("./inspect.ts")
            return inspectI18n(resolveLingui(inspectionRoot()))
          },
        }],
        providerOutput: [{
          description: "Compiled messages that the server loads",
          owner: "i18n",
          path: resolve(inspectionRoot(), generatedMessages),
        }],
      }),
    },
    config: {
      order: "pre",
      async handler(config) {
        const viteHubConfig = config as ViteHubConfig
        setup(viteHubConfig)
        const nitroMajor = viteHubConfig[VITEHUB_NITRO_MAJOR_VERSION] ?? 3
        await writeServerFiles(nitroMajor)
        const kit = createNitroServerKit(viteHubConfig.nitro)
        kit.addPlugin(resolve(projectRoot!, generatedPlugin), "start")
        // Nitro runs each request in an async context, so `t` in server code finds the locale of its request.
        const nitro = kit.config as Record<string, unknown> & { experimental?: Record<string, unknown> }
        nitro.experimental = { ...nitro.experimental, asyncContext: true }
        viteHubConfig.nitro = nitro
        return {
          optimizeDeps: { exclude: [packageName, "vite-hub/i18n"] },
        }
      },
    },
    configResolved(config) {
      isProduction = config.isProduction
      const vue = config.plugins.find(plugin => plugin.name === "vite:vue") as (Plugin & { api?: { options?: VueOptions } }) | undefined
      // Without Vue, messages still work in scripts and server code.
      if (vue?.api?.options) installTemplateTransform(vue.api.options, isProduction)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    resolveId(id) {
      if (id === clientModule) return resolvedClientModule
    },
    load(id) {
      if (id !== resolvedClientModule || !projectRoot || !locale) return
      return renderClientModule(importBase, projectRoot, locale)
    },
    transform: {
      filter: { id: { include: [/\.po$/, sourceRe], exclude: [nodeModulesRe, otherFormQueryRe] } },
      async handler(code, id) {
        if (!lingui || nodeModulesRe.test(id) || otherFormQueryRe.test(id)) return
        const file = id.split("?")[0]!
        if (file.endsWith(".po")) {
          const compiled = await compileCatalogModule(lingui, relative(lingui.rootDir, file))
          if (!compiled) return
          for (const dependency of compiled.dependencies) this.addWatchFile(dependency)
          return { code: compiled.code, map: null, moduleType: "js" }
        }
        if (!sourceRe.test(id)) return
        return transformMacros(code, id, lingui, importBase, isProduction ? "id-only" : "all")
      },
    },
    async handleHotUpdate(context) {
      if (!context.file.endsWith(".po")) return
      const nitroMajor = (context.server.config as ViteHubConfig)[VITEHUB_NITRO_MAJOR_VERSION] ?? 3
      await writeServerFiles(nitroMajor)
    },
  }
}

interface VueOptions {
  template?: { compilerOptions?: { nodeTransforms?: unknown[] } }
}

function installTemplateTransform(vueOptions: VueOptions, isProduction: boolean): void {
  const template = vueOptions.template ??= {}
  const compilerOptions = template.compilerOptions ??= {}
  const nodeTransforms = compilerOptions.nodeTransforms ??= []
  if (nodeTransforms.some(isLinguiTemplateTransform)) return
  nodeTransforms.push(linguiTemplateTransform({ descriptorFields: isProduction ? "id-only" : "all" }))
}
