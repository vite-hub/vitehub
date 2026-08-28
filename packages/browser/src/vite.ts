import { normalize, resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import {
  contributeProviderDeploymentOutput,
  createProviderDeploymentOutputGenerationState,
  finalizeProviderDeploymentOutputs,
  resetProviderDeploymentOutputs,
  useProviderOutputCatalog,
} from "@vite-hub/internal/build/deployment-output"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import {
  createNoExternalMerger,
  isServerEnvironment,
  resolveViteHubProjectRoot,
  shouldSkipViteProviderBuild,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"

import { discoverBrowserDefinitions } from "./discovery.ts"

import type { Plugin, ResolvedConfig } from "vite"
import type { BrowserEngine } from "./types.ts"

export interface BrowserModuleOptions {
  binding?: string
  engine?: BrowserEngine
  remote?: boolean
}

export type BrowserVitePlugin = Plugin & {
  api: {
    getConfig(): Required<BrowserModuleOptions>
  }
}

const browserRegistryId = "#vitehub/browser/registry"
const browserRuntimeId = "#vitehub/browser/runtime"
const resolvedBrowserRegistryId = `\0${browserRegistryId}`
const resolvedBrowserRuntimeId = `\0${browserRuntimeId}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/browser")
const browserWranglerConfigOwnership = {
  keys: ["browser"],
  arrays: {
    compatibility_flags: {
      preserveOnCleanup: true,
      values: ["nodejs_compat"],
    },
  },
}

function resolveOptions(options: BrowserModuleOptions | false | undefined): Required<BrowserModuleOptions> {
  const binding = options && options.binding || "BROWSER"
  const engine = !options ? "kitesurf" : options.engine ?? "kitesurf"
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) {
    throw new TypeError("[vitehub:browser] Browser binding must be a valid Cloudflare binding name.")
  }
  if (engine !== "chromium" && engine !== "kitesurf") {
    throw new TypeError("[vitehub:browser] Browser engine must be \"chromium\" or \"kitesurf\".")
  }
  return { binding, engine, remote: Boolean(options && options.remote) }
}

function browserBinding(options: Required<BrowserModuleOptions>) {
  return {
    binding: options.binding,
    ...(options.remote ? { remote: true } : {}),
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function configureNitroBrowser(value: unknown, options: Required<BrowserModuleOptions>, enabled: boolean): Record<string, unknown> {
  const nitro = cloneRecord(value)
  const cloudflare = cloneRecord(nitro.cloudflare)
  const wrangler = cloneRecord(cloudflare.wrangler)
  const rollupConfig = cloneRecord(nitro.rollupConfig)
  if (!enabled) {
    delete wrangler.browser
    return { ...nitro, cloudflare: { ...cloudflare, wrangler } }
  }
  return {
    ...nitro,
    cloudflare: {
      ...cloudflare,
      nodeCompat: true,
      wrangler: {
        ...wrangler,
        browser: browserBinding(options),
      },
    },
    rollupConfig: { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") },
  }
}

function isBrowserDefinitionUpdate(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const normalized = normalize(file).replace(/\\/g, "/")
  if (/\.browser\.(?:c|m)?[jt]s$/i.test(normalized)) return true
  return (serverDirs ?? [resolve(projectRoot, "server")]).some((directory) => {
    const browserDirectory = `${resolve(directory, "browsers").replace(/\\/g, "/")}/`
    return normalized.startsWith(browserDirectory) && /\.(?:c|m)?[jt]sx?$/i.test(normalized.slice(browserDirectory.length))
  })
}

function renderBrowserRegistryTypes(definitions: ReturnType<typeof discoverBrowserDefinitions>) {
  return [
    "declare global {",
    "  interface ViteHubBrowserDefinitionModules {",
    ...definitions.map(definition =>
      `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`
    ),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

export function hubBrowser(options?: BrowserModuleOptions | false): BrowserVitePlugin {
  let enabled = options !== false
  let resolvedOptions = resolveOptions(options)
  let resolved: ResolvedConfig | undefined
  let providerOutput: ReturnType<typeof useProviderOutputCatalog> | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let projectRoot = process.cwd()
  let serverDirs: string[] | undefined

  function discoverDefinitions(root: string) {
    return discoverBrowserDefinitions({
      rootDir: root,
      serverDirs,
      serverRootDir: projectRoot,
    })
  }

  function registryContents(root: string) {
    const definitions = enabled ? discoverDefinitions(root) : []
    return [
      "const registry = {",
      ...definitions.map(definition =>
        `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(definition.handler)}),`
      ),
      "}",
      "",
      "export default registry",
      "",
    ].join("\n")
  }

  function runtimeContents() {
    return [
      `export default ${JSON.stringify(enabled ? {
        binding: resolvedOptions.binding,
        engine: resolvedOptions.engine,
        provider: "cloudflare",
      } : {}, null, 2)}`,
      "",
    ].join("\n")
  }

  async function refreshRegistryTypes(root: string) {
    const definitions = enabled ? discoverDefinitions(root) : []
    await writeFileIfChanged(
      resolve(projectRoot, ".vitehub", "types", "browser.d.ts"),
      renderBrowserRegistryTypes(definitions),
    )
  }

  const applyConfig = (config: { browser?: BrowserModuleOptions | false, nitro?: unknown, root?: string }) => {
    const configured = config.browser ?? options
    enabled = configured !== false
    resolvedOptions = resolveOptions(configured)
    projectRoot = resolveViteHubProjectRoot(config.root || process.cwd())
    serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    config.nitro = configureNitroBrowser(config.nitro, resolvedOptions, enabled)
  }

  return {
    name: "@vite-hub/browser/vite",
    enforce: "pre",
    api: { getConfig: () => resolvedOptions },
    config(config) {
      applyConfig(config)
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      applyConfig(config)
      await refreshRegistryTypes(config.root)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      if (!isBrowserDefinitionUpdate(context.file, projectRoot, serverDirs)) return
      await refreshRegistryTypes(context.server.config.root)
      const registryModule = context.server.moduleGraph.getModuleById(resolvedBrowserRegistryId)
      if (registryModule) context.server.moduleGraph.invalidateModule(registryModule)
    },
    resolveId(id) {
      if (id === browserRegistryId) return resolvedBrowserRegistryId
      if (id === browserRuntimeId) return resolvedBrowserRuntimeId
    },
    load(id) {
      if (id === resolvedBrowserRegistryId) return registryContents(resolved?.root || process.cwd())
      if (id === resolvedBrowserRuntimeId) return runtimeContents()
    },
    buildStart() {
      providerOutputGenerations.capture(this, providerOutput)
    },
    async buildEnd(error) {
      if (error) {
        await resetProviderDeploymentOutputs(providerOutput, error)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
      const rootDir = resolved.root
      const clientOutDir = resolved.build.outDir
      const cloudflare = enabled
        ? {
            wranglerConfig: {
              browser: browserBinding(resolvedOptions),
              compatibility_flags: ["nodejs_compat"],
            },
            wranglerConfigDefaults: {
              compatibility_date: defaultCloudflareCompatibilityDate,
            },
            wranglerConfigOwnership: browserWranglerConfigOwnership,
          }
        : undefined
      contributeProviderDeploymentOutput(providerOutput, {
        owner: "browser",
        rootDir,
        write: async ({ write }) => await write({
          clientOutDir,
          rootDir,
          cloudflare,
          cleanup: {
            cloudflare: {
              wranglerConfigOwnership: browserWranglerConfigOwnership,
            },
          },
        }),
      }, providerOutputGenerations.get(this))
    },
    async renderError(error) {
      await resetProviderDeploymentOutputs(providerOutput, error)
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    browser?: BrowserModuleOptions | false
  }
}
