import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment, resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import { discoverEmailDefinition } from "./discovery.ts"

import type { EnvRuntimeConfigOptions, EnvRuntimeRegistry } from "@vite-hub/env"
import type { DiscoveredEmailDefinition } from "./discovery.ts"
import type { Plugin, ResolvedConfig } from "vite"

export const EMAIL_DEFINITION_ID = "#vitehub/email/definition"
export const EMAIL_VITE_PLUGIN_NAME = "@vite-hub/email/vite"

const resolvedEmailDefinitionId = `\0${EMAIL_DEFINITION_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/email")
const resolvePackageImport = createRequire(import.meta.url).resolve
const unemailDriverPattern = /^unemail\/driver\/[a-z0-9][a-z0-9-]*$/

export type UnemailDriverSpecifier = `unemail/driver/${string}`

export interface ConfiguredEmailDefinition {
  driver: UnemailDriverSpecifier
  handler: string
  name: "default"
  options: EnvRuntimeRegistry
  source: "vite-config"
}

export type EmailViteDefinition = ConfiguredEmailDefinition | DiscoveredEmailDefinition

interface EmailViteDiscoveryOptions {
  driver?: never
  options?: never
  projectRoot?: string
}

interface EmailViteDriverOptions {
  driver: UnemailDriverSpecifier
  options?: EnvRuntimeConfigOptions
  projectRoot?: never
}

export type EmailVitePluginOptions = EmailViteDiscoveryOptions | EmailViteDriverOptions

export interface EmailVitePluginAPI {
  getDefinition: () => EmailViteDefinition | undefined
  refresh: () => EmailViteDefinition | undefined
}

export type EmailVitePlugin = Plugin & { api: EmailVitePluginAPI }

interface InternalEmailVitePluginOptions {
  hosting?: string
  runtimeEnvImport?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuntimeEnvEntry(value: unknown): value is { secret: boolean, source: unknown } {
  return isRecord(value) && isRecord(value.source) && typeof value.secret === "boolean"
}

function renderResolvedOptions(value: unknown, reference: string): string {
  if (isRuntimeEnvEntry(value)) return value.secret ? `${reference}?.unseal()` : reference
  if (!isRecord(value) || value.kind === "literal") return reference
  return `{ ${Object.entries(value).map(([key, child]) =>
    `${JSON.stringify(key)}: ${renderResolvedOptions(child, `${reference}[${JSON.stringify(key)}]`)}`
  ).join(", ")} }`
}

function resolveDriverImport(driver: string): string {
  if (!unemailDriverPattern.test(driver)) {
    throw new TypeError("[vitehub] Email driver must be an unemail/driver/* package subpath.")
  }
  try {
    return resolvePackageImport(driver)
  }
  catch (error) {
    throw new Error(`[vitehub] Could not resolve Email driver ${JSON.stringify(driver)} from Unemail.`, { cause: error })
  }
}

function configuredDefinition(options: EmailVitePluginOptions): Omit<ConfiguredEmailDefinition, "handler"> | undefined {
  if (!("driver" in options) || !options.driver) {
    if ("options" in options && options.options) {
      throw new TypeError("[vitehub] Email options require an unemail/driver/* driver.")
    }
    return
  }
  return {
    driver: options.driver,
    name: "default",
    options: createRuntimeEnvRegistry(options.options, { path: "email.options" }),
    source: "vite-config",
  }
}

function renderEmailDefinitionModule(
  definition: EmailViteDefinition | undefined,
): string {
  if (!definition) return "export const definition = undefined\nexport default definition\n"
  return [
    `import definition from ${JSON.stringify(definition.handler)}`,
    "export { definition }",
    "export default definition",
    "",
  ].join("\n")
}

function renderConfiguredEmailDefinitionModule(
  definition: ConfiguredEmailDefinition,
  driverImport: string,
  runtimeEnvImport: string,
  cloudflare: boolean,
): string {
  return [
    `import createDriver from ${JSON.stringify(driverImport)}`,
    `import { resolveServerEnv } from ${JSON.stringify(runtimeEnvImport)}`,
    ...(cloudflare ? ["import { env as vitehubEmailEnv } from \"cloudflare:workers\""] : []),
    "",
    `const registry = ${JSON.stringify(definition.options, null, 2)}`,
    "export const definition = {",
    "  driver: () => {",
    `    const options = resolveServerEnv(registry${cloudflare ? ", { env: vitehubEmailEnv }" : ""})`,
    `    return createDriver(${renderResolvedOptions(definition.options, "options")})`,
    "  },",
    "}",
    "export default definition",
    "",
  ].join("\n")
}

function isEmailDefinitionFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/")
  return /\/?server\.email\.(?:c|m)?[jt]s$/i.test(normalized)
    || /\/server\/email\.(?:c|m)?[jt]s$/i.test(normalized)
}

function resolveHosting(options: InternalEmailVitePluginOptions, config: Record<string, unknown>): string | undefined {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const preset = typeof nitro.preset === "string" ? nitro.preset : undefined
  return options.hosting ?? preset ?? process.env.NITRO_PRESET ?? process.env.SERVER_PRESET ?? process.env.VITEHUB_HOSTING
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

function configureNitroCloudflareWorkers(config: Record<string, unknown>): Record<string, unknown> {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const rollupConfig = isRecord(nitro.rollupConfig) ? nitro.rollupConfig : {}
  return {
    ...nitro,
    rollupConfig: { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") },
  }
}

export function hubEmail(options: EmailVitePluginOptions = {}): EmailVitePlugin {
  const internalOptions = options as EmailVitePluginOptions & InternalEmailVitePluginOptions
  const configured = configuredDefinition(options)
  const driverImport = configured ? resolveDriverImport(configured.driver) : undefined
  const runtimeEnvImport = internalOptions.runtimeEnvImport
    ?? resolve(dirname(resolvePackageImport("@vite-hub/env/package.json")), "dist/server.js")
  let cloudflare = false
  let resolved: ResolvedConfig | undefined
  let definition: EmailViteDefinition | undefined
  let serverDirs: string[] | undefined

  function refresh(): EmailViteDefinition | undefined {
    const viteRoot = resolve(resolved?.root ?? process.cwd())
    const projectRoot = resolveViteHubProjectRoot(viteRoot, { projectRoot: options.projectRoot })
    const discovered = discoverEmailDefinition(projectRoot, { serverDirs })
    if (configured && discovered) {
      throw new Error(`[vitehub] Email is configured with ${JSON.stringify(configured.driver)} and ${discovered.handler}. Remove one definition.`)
    }
    definition = configured
      ? {
          ...configured,
          handler: resolve(resolveViteHubGeneratedRoot(resolved ?? { root: viteRoot }), "email/definition.mjs"),
        }
      : discovered
    return definition
  }

  return {
    name: EMAIL_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinition: () => definition,
      refresh,
    },
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      cloudflare = getHostingProvider(resolveHosting(internalOptions, config as Record<string, unknown>)) === "cloudflare"
      return {
        ...(cloudflare ? { nitro: configureNitroCloudflareWorkers(config as Record<string, unknown>) } : {}),
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
    },
    async configResolved(config) {
      resolved = config
      const current = refresh()
      if (current?.source === "vite-config" && driverImport) {
        const entry = current.handler.replace(/\.mjs$/, ".entry.mjs")
        await writeFileIfChanged(entry, renderConfiguredEmailDefinitionModule(current, driverImport, runtimeEnvImport, cloudflare))
        try {
          await bundleEsmEntry(entry, current.handler, {
            external: cloudflare ? ["cloudflare:workers"] : undefined,
            format: "esm",
            minifyWhitespace: true,
            platform: "node",
            rootDir: config.root,
          })
        }
        finally {
          await rm(entry, { force: true })
        }
      }
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    handleHotUpdate(context) {
      const changed = context.file.replace(/\\/g, "/")
      const current = definition?.source === "vite-config" ? undefined : definition?.handler.replace(/\\/g, "/")
      if (changed !== current && !isEmailDefinitionFile(changed)) return

      resolved = context.server.config
      refresh()
      const module = context.server.moduleGraph.getModuleById(resolvedEmailDefinitionId)
      if (module) context.server.moduleGraph.invalidateModule(module)
    },
    resolveId(id) {
      if (id === EMAIL_DEFINITION_ID) return resolvedEmailDefinitionId
    },
    load(id) {
      if (id === resolvedEmailDefinitionId) {
        return renderEmailDefinitionModule(definition)
      }
    },
  }
}
