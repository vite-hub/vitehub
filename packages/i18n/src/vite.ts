import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { createNoExternalAddition, isServerEnvironment, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { isLinguiTemplateTransform, linguiTemplateTransform } from "@lingui/vue/compiler"
import MagicString from "magic-string"

import { compileMessages } from "./catalogs.ts"
import { i18nErrorDiagnostics } from "./errors.ts"
import { createLinguiConfig, recordsRoot } from "./lingui.ts"
import { resolveI18nLocaleConfig } from "./locales.ts"
import { transformMacros } from "./macros.ts"
import { addMessage, allMessages, extractFileMessages, manifestFile, mergeMessages, scanMessages } from "./manifest.ts"
import { readRecords } from "./records.ts"

import type { LinguiConfigNormalized } from "@lingui/conf"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { I18nLocaleConfig, I18nOptions } from "./locales.ts"
import type { I18nManifest, SourceMessages } from "./manifest.ts"
import type { TranslationRecords } from "./records.ts"

const packageName = "@vite-hub/i18n"
const pluginName = "@vite-hub/i18n/vite"
const clientModule = "virtual:vite-hub/i18n/client"
const resolvedClientModule = `\0${clientModule}`
const catalogModule = "virtual:vite-hub/i18n/catalog/"
const resolvedCatalogModule = `\0${catalogModule}`
/** A production catalog holds this string until the chunk renders. Then every message of the bundle is known. */
const catalogMarker = (locale: string) => `__VITEHUB_I18N_CATALOG_${locale}__`
const catalogMarkerRe = /"__VITEHUB_I18N_CATALOG_([\w-]+)__"/g
const buildMessagesModule = "virtual:vite-hub/i18n/build-messages"
const resolvedBuildMessagesModule = `\0${buildMessagesModule}`
const clientIdsMarker = "__VITEHUB_I18N_CLIENT_IDS__"
const sourcesMarker = "__VITEHUB_I18N_SOURCES__"
const generatedPlugin = ".vitehub/nitro/i18n/plugin.mjs"
const generatedRoute = ".vitehub/nitro/i18n/catalog.mjs"
/** The browser reads live catalogs from `<liveRoute>/<locale>.json`. */
const liveRoute = "/_vitehub/i18n"
const generatedMessages = ".vitehub/i18n/messages.mjs"
const mergeNoExternal = createNoExternalAddition(packageName)

const sourceRe = /\.(?:vue|[cm]?[jt]sx?)(?:\?.*)?$/
const recordRe = /[\\/]locales[\\/][^\\/]+[\\/]segments[\\/][\da-f]{2}[\\/][\da-f]{16}\.json$/
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

type ViteHubConfig = (UserConfig | ResolvedConfig) & { i18n?: I18nOptions, nitro?: unknown }

function renderNitroPlugin(importBase: string, messagesFile: string, workspace: string | undefined): string {
  // `vite-hub/i18n` gets the Workspace from `vite-hub/workspace/files`, and `@vite-hub/i18n` from `@vite-hub/workspace/files`.
  const workspaceImport = importBase.replace(/i18n$/, "workspace/files")
  return [
    `import { definePlugin } from "nitro"`,
    `import { useRequest } from "nitro/context"`,
    `import { installI18nServer } from ${JSON.stringify(`${importBase}/server`)}`,
    `import { config, messages } from ${JSON.stringify(messagesFile)}`,
    ...(workspace
      ? [
          `import { clientIds, sources } from ${JSON.stringify(buildMessagesModule)}`,
          `import { useWorkspaceFiles } from ${JSON.stringify(workspaceImport)}`,
        ]
      : []),
    "",
    "export default definePlugin((nitroApp) => {",
    "  installI18nServer(nitroApp, {",
    "    config,",
    "    messages,",
    "    current: () => {",
    "      try { return useRequest() }",
    "      catch { return undefined }",
    "    },",
    ...(workspace
      ? [`    workspace: { name: ${JSON.stringify(workspace)}, open: mode => useWorkspaceFiles(${JSON.stringify(workspace)}, { mode }), clientIds, sources },`]
      : []),
    "  })",
    "})",
    "",
  ].join("\n")
}

function renderCatalogRoute(importBase: string): string {
  return [
    `import { i18nCatalogResponse } from ${JSON.stringify(`${importBase}/server`)}`,
    "",
    "export default event => i18nCatalogResponse(event.req)",
    "",
  ].join("\n")
}

function renderClientModule(importBase: string, locale: I18nLocaleConfig, live: boolean): string {
  const loaders = locale.locales.map(entry => `    ${JSON.stringify(entry)}: () => import(${JSON.stringify(`${catalogModule}${entry}`)}),`)
  return [
    `import { configureI18n } from ${JSON.stringify(`${importBase}/runtime`)}`,
    "",
    "configureI18n({",
    `  locales: ${JSON.stringify(locale.locales)},`,
    `  sourceLocale: ${JSON.stringify(locale.sourceLocale)},`,
    `  cookie: ${JSON.stringify(locale.cookie)},`,
    ...(live ? [`  live: ${JSON.stringify(liveRoute)},`] : []),
    "  catalogs: {",
    ...loaders,
    "  },",
    "})",
    "",
  ].join("\n")
}

/**
 * Fails the build when `i18n.workspace` names no Workspace of the app. A wrong name would otherwise only log an error on
 * each read of the published translations. The Workspace plugin runs first and lists its Workspaces in `buildStart`,
 * after other plugins, such as Content, contribute theirs, so this check sees every definition.
 */
function assertWorkspaceDefined(workspace: string, plugins: readonly Plugin[]): void {
  // `@vite-hub/workspace/vite` lists its Workspaces in `api.getWorkspaces()`. i18n does not depend on that package.
  const api: { getWorkspaces?: () => Array<{ name: string }> } | undefined = plugins.find(entry => entry.name === "@vite-hub/workspace/vite")?.api
  const workspaces = api?.getWorkspaces?.().map(entry => entry.name)
  if (workspaces?.includes(workspace)) return
  throw i18nErrorDiagnostics.I18N_UNKNOWN_WORKSPACE({ workspace, workspaces })
}

/** Vite plugin of ViteHub i18n. `vitehub({ i18n })` and `vite-hub/nuxt` add it for you. */
export function hubI18n(options: I18nVitePluginOptions = {}): I18nVitePlugin {
  const importBase = (options as InternalOptions).importBase ?? packageName
  let configured: I18nVitePluginOptions = options
  let projectRoot: string | undefined
  let locale: I18nLocaleConfig | undefined
  let lingui: LinguiConfigNormalized | undefined
  let isProduction = false
  let isBuild = false
  let plugins: readonly Plugin[] = []
  /** Messages of each environment in this build. The client catalogs and the manifest come from it. */
  const manifest: I18nManifest = { environments: {} }
  const moduleMessages = new Map<string, Map<string, SourceMessages>>()
  let manifestWrite = Promise.resolve()
  let serverWrite = Promise.resolve()
  let buildRecords: Promise<Record<string, TranslationRecords>> | undefined
  /** Environments whose code runs in the browser. */
  const browserEnvironments = new Set<string>()

  const setup = (config: ViteHubConfig): void => {
    configured = { ...options, ...config.i18n }
    projectRoot = resolveViteHubProjectRoot(config.root || process.cwd(), { projectRoot: configured.projectRoot })
    locale = resolveI18nLocaleConfig({ locales: configured.locales ?? [], cookie: configured.cookie })
    lingui = createLinguiConfig({ rootDir: projectRoot, locale, importBase })
  }

  const readAllRecords = async (): Promise<Record<string, TranslationRecords>> => {
    if (!projectRoot || !locale) return {}
    const root = recordsRoot(projectRoot)
    const entries = await Promise.all(locale.locales.map(async entry =>
      [entry, entry === locale!.sourceLocale ? {} : (await readRecords(root, entry)).records] as const))
    return Object.fromEntries(entries)
  }

  // Server code keeps the source text of each message, so the server needs only the translations.
  const writeServerFiles = (): Promise<void> => {
    // Watcher callbacks overlap. Read each snapshot inside the queue so an older read cannot overwrite a new one.
    serverWrite = serverWrite.catch(() => {}).then(async () => {
      if (!projectRoot || !locale || !lingui) return
      const messagesFile = resolve(projectRoot, generatedMessages)
      const records = await readAllRecords()
      const messages = Object.fromEntries(locale.locales.map(entry => [entry, compileMessages(records[entry] ?? {})]))
      await writeFileIfChanged(messagesFile, [
        `export const config = ${JSON.stringify({ ...locale, catalogs: {} })}`,
        `export const messages = ${JSON.stringify(messages)}`,
        "",
      ].join("\n"))
      await writeFileIfChanged(resolve(projectRoot, generatedPlugin), renderNitroPlugin(importBase, messagesFile, configured.workspace))
      if (configured.workspace) await writeFileIfChanged(resolve(projectRoot, generatedRoute), renderCatalogRoute(importBase))
    })
    return serverWrite
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
    sharedDuringBuild: true,
    vitehub: {
      cli: async () => {
        const { createI18nCliContributor } = await import("./cli.ts")
        return createI18nCliContributor(resolveLingui, () => configured.workspace)
      },
      inspect: () => ({
        definitions: [{
          kind: "i18n",
          label: "Locales",
          list: async () => {
            const { inspectI18n } = await import("./inspect.ts")
            const status = await inspectI18n(resolveLingui(inspectionRoot()))
            return status.locales.map(entry => ({
              fields: [
                { label: "Messages", value: String(entry.messages) },
                { label: "Translated", value: String(entry.translated) },
                { label: "Missing", value: String(entry.missing) },
                { label: "Unused", value: String(entry.unused) },
              ],
              file: entry.folder || manifestFile,
              name: entry.source ? `${entry.locale} (source)` : entry.locale,
              source: "locales",
            }))
          },
        }],
        providerOutput: [
          {
            description: "Compiled translations that the server loads",
            owner: "i18n",
            path: resolve(inspectionRoot(), generatedMessages),
          },
          {
            description: "Source messages of the last build, by environment",
            owner: "i18n",
            path: resolve(inspectionRoot(), manifestFile),
          },
        ],
      }),
    },
    config: {
      order: "pre",
      async handler(config, env) {
        const viteHubConfig = config as ViteHubConfig
        isBuild = env?.command === "build"
        setup(viteHubConfig)
        await writeServerFiles()
        const kit = createNitroServerKit(viteHubConfig.nitro)
        kit.addPlugin(resolve(projectRoot!, generatedPlugin), "start")
        if (configured.workspace) kit.addHandler({ route: `${liveRoute}/:file`, method: "GET", handler: resolve(projectRoot!, generatedRoute) })
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
      plugins = config.plugins
      const vue = config.plugins.find(plugin => plugin.name === "vite:vue") as (Plugin & { api?: { options?: VueOptions } }) | undefined
      // Without Vue, messages still work in scripts and server code.
      if (vue?.api?.options) installTemplateTransform(vue.api.options, isProduction)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    buildStart() {
      buildRecords = undefined
      if (configured.workspace) assertWorkspaceDefined(configured.workspace, plugins)
    },
    resolveId(id) {
      if (id === clientModule) return resolvedClientModule
      if (id === buildMessagesModule) return resolvedBuildMessagesModule
      if (id.startsWith(catalogModule)) return `\0${id}`
    },
    async load(id) {
      if (!projectRoot || !locale) return
      if (id === resolvedClientModule) return renderClientModule(importBase, locale, Boolean(configured.workspace))
      if (id === resolvedBuildMessagesModule) {
        // The server sends the browser only the translations of browser messages, and lists the messages that a
        // locale does not translate. A build fills both when the server chunk renders. Development sends every
        // translation and reads the messages of the code when the server starts.
        if (isBuild) return `export const clientIds = ${JSON.stringify(clientIdsMarker)}\nexport const sources = ${JSON.stringify(sourcesMarker)}\n`
        return `export const clientIds = null\nexport const sources = ${JSON.stringify(lingui ? await scanMessages(lingui) : {})}\n`
      }
      if (!id.startsWith(resolvedCatalogModule)) return
      const entry = locale.locales.find(candidate => candidate === id.slice(resolvedCatalogModule.length))
      if (!entry) return
      // A production build fills the catalog when the chunk renders, after every module has given its messages.
      if (isBuild) return `export const messages = ${JSON.stringify(catalogMarker(entry))}\n`
      const records = entry === locale.sourceLocale ? {} : (await readRecords(recordsRoot(projectRoot), entry)).records
      return `export const messages = ${JSON.stringify(compileMessages(records))}\n`
    },
    transform: {
      filter: { id: { include: [sourceRe], exclude: [nodeModulesRe, otherFormQueryRe] } },
      async handler(code, id) {
        if (!lingui || nodeModulesRe.test(id) || otherFormQueryRe.test(id) || !sourceRe.test(id)) return
        const server = this.environment.config.consumer === "server"
        if (isBuild) {
          // The build reads each message from the file on disk, so origins point at the lines that you wrote.
          const file = id.split("?")[0]!
          const source = await readFile(file, "utf8").catch(() => undefined)
          if (!server) browserEnvironments.add(this.environment.name)
          const messages: SourceMessages = {}
          for (const message of source ? await extractFileMessages(file, source, lingui) : []) addMessage(messages, message, lingui.rootDir)
          let modules = moduleMessages.get(this.environment.name)
          if (!modules) moduleMessages.set(this.environment.name, modules = new Map())
          modules.set(id, messages)
        }
        // Browser code ships only message IDs. Server code keeps the source text, so a message without a
        // translation falls back to it.
        return transformMacros(code, id, lingui, importBase, isProduction && !server ? "id-only" : "all")
      },
    },
    renderStart() {
      // Cached modules may skip transform on a watch rebuild. Keep their contributions, but only for modules
      // that are still in the current graph, and replace each changed module's previous contribution.
      const modules = moduleMessages.get(this.environment.name)
      const active = new Set(this.getModuleIds())
      const sources: SourceMessages[] = []
      for (const [id, messages] of modules ?? []) {
        if (!active.has(id)) {
          modules!.delete(id)
          continue
        }
        sources.push(messages)
      }
      manifest.environments[this.environment.name] = mergeMessages(sources)
    },
    async renderChunk(code) {
      if (code.includes(clientIdsMarker) || code.includes(sourcesMarker)) {
        // The server builds after the browser, so every browser message is known here.
        const ids = [...browserEnvironments].flatMap(name => Object.keys(manifest.environments[name] ?? {}))
        const values: Record<string, string> = {
          [clientIdsMarker]: JSON.stringify([...new Set(ids)].sort()),
          [sourcesMarker]: JSON.stringify(allMessages(manifest)),
        }
        const output = new MagicString(code)
        for (const match of code.matchAll(new RegExp(`"(${clientIdsMarker}|${sourcesMarker})"`, "g"))) {
          output.overwrite(match.index, match.index + match[0].length, values[match[1]!]!)
        }
        return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) }
      }
      if (!code.includes("__VITEHUB_I18N_CATALOG_")) return
      // The catalog of an environment holds only the messages of its code. Translations of server-only messages
      // stay out of the browser.
      const sources = manifest.environments[this.environment.name] ?? {}
      const records = await (buildRecords ??= readAllRecords())
      const output = new MagicString(code)
      for (const match of code.matchAll(catalogMarkerRe)) {
        const entry = match[1]!
        output.overwrite(match.index, match.index + match[0].length, JSON.stringify(compileMessages(records[entry] ?? {}, sources)))
      }
      return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) }
    },
    async writeBundle() {
      if (!projectRoot) return
      const file = resolve(projectRoot, manifestFile)
      // Environments can finish concurrently. Serialize snapshots so an older write cannot finish after the
      // final one, and rename a complete file so readers never see a partially written snapshot.
      manifestWrite = manifestWrite.catch(() => {}).then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await mkdir(resolve(file, ".."), { recursive: true })
          await writeFile(temporary, `${JSON.stringify(sortManifest(manifest), null, 2)}\n`, "utf8")
          await rename(temporary, file)
        }
        finally {
          await rm(temporary, { force: true })
        }
      })
      await manifestWrite
    },
    configureServer(server) {
      if (!projectRoot) return
      // The records folder can sit outside the Vite root, as in Nuxt. Watch it, and reload the server and the page
      // after a record changes.
      server.watcher.add(recordsRoot(projectRoot))
      server.watcher.on("all", async (_event, file) => {
        if (!recordRe.test(file)) return
        await writeServerFiles()
        const messagesFile = resolve(projectRoot!, generatedMessages)
        for (const environment of Object.values(server.environments)) {
          const graph = environment.moduleGraph
          const modules = [
            ...(locale?.locales.map(entry => graph.getModuleById(`${resolvedCatalogModule}${entry}`)) ?? []),
            ...(graph.getModulesByFile(messagesFile) ?? []),
          ]
          for (const module of modules) if (module) graph.invalidateModule(module)
          environment.hot.send({ type: "full-reload" })
        }
      })
    },
  }
}

function sortManifest(manifest: I18nManifest): I18nManifest {
  const environments: Record<string, SourceMessages> = {}
  for (const name of Object.keys(manifest.environments).sort()) {
    const messages = manifest.environments[name]!
    environments[name] = Object.fromEntries(Object.keys(messages).sort().map(id => [id, messages[id]!]))
  }
  return { environments }
}

interface VueOptions {
  template?: { compilerOptions?: { nodeTransforms?: unknown[] } }
}

const templateTransformKey = Symbol.for("vite-hub.i18n.template-transform")

type NodeTransform = (node: unknown, context: { ssr?: boolean, inSSR?: boolean }) => unknown

/** Browser templates get message IDs only in production. Server templates keep the source text as a fallback. */
function installTemplateTransform(vueOptions: VueOptions, isProduction: boolean): void {
  const template = vueOptions.template ??= {}
  const compilerOptions = template.compilerOptions ??= {}
  const nodeTransforms = compilerOptions.nodeTransforms ??= []
  if (nodeTransforms.some(transform => isLinguiTemplateTransform(transform) || (transform as { [templateTransformKey]?: true })[templateTransformKey])) return
  const browser = linguiTemplateTransform({ descriptorFields: isProduction ? "id-only" : "all" }) as NodeTransform
  const server = linguiTemplateTransform({ descriptorFields: "all" }) as NodeTransform
  const transform: NodeTransform = (node, context) => (context.ssr || context.inSSR ? server : browser)(node, context)
  nodeTransforms.push(Object.assign(transform, { [templateTransformKey]: true }))
}
