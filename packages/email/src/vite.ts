import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment, resolveViteHubGeneratedRoot } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import type { EnvRuntimeConfigOptions, EnvRuntimeRegistry } from "@vite-hub/env"
import type { Plugin } from "vite"

export const EMAIL_DEFINITION_ID = "#vitehub/email/definition"
export const EMAIL_VITE_PLUGIN_NAME = "@vite-hub/email/vite"

const resolvedEmailDefinitionId = `\0${EMAIL_DEFINITION_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/email")
const resolvePackageImport = createRequire(import.meta.url).resolve
const unemailDriverPattern = /^unemail\/driver\/[a-z0-9][a-z0-9-]*$/

export type UnemailDriverSpecifier = `unemail/driver/${string}`

interface GeneratedEmailDefinition {
  driver: UnemailDriverSpecifier
  handler: string
  name: "default"
  options: EnvRuntimeRegistry
}

export interface EmailVitePluginOptions {
  driver: UnemailDriverSpecifier
  options?: EnvRuntimeConfigOptions
}

export interface EmailVitePluginAPI {
  getDefinition: () => GeneratedEmailDefinition | undefined
}

export type EmailVitePlugin = Plugin & { api: EmailVitePluginAPI }

interface InternalEmailVitePluginOptions {
  hosting?: string
  runtimeEnvImport?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuntimeEnvEntry(value: unknown): value is { default?: unknown, secret: boolean, source: unknown } {
  return isRecord(value) && isRecord(value.source) && typeof value.secret === "boolean"
}

function rejectSecretDefaults(value: unknown, path = "email.options"): void {
  if (isRuntimeEnvEntry(value)) {
    if (value.secret && typeof value.default !== "undefined") {
      throw new TypeError(`[vitehub] Secret Email declaration ${path} cannot have a default because defaults are included in build output.`)
    }
    return
  }
  if (!isRecord(value) || value.kind === "literal") return
  for (const [key, child] of Object.entries(value)) {
    rejectSecretDefaults(child, `${path}.${key}`)
  }
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

function configuredDefinition(options: EmailVitePluginOptions): Omit<GeneratedEmailDefinition, "handler"> {
  const runtimeOptions = createRuntimeEnvRegistry(options.options, { path: "email.options" })
  rejectSecretDefaults(runtimeOptions)
  return {
    driver: options.driver,
    name: "default",
    options: runtimeOptions,
  }
}

function renderEmailDefinitionModule(
  definition: GeneratedEmailDefinition,
): string {
  return [
    `import definition from ${JSON.stringify(definition.handler)}`,
    "export { definition }",
    "export default definition",
    "",
  ].join("\n")
}

function renderConfiguredEmailDefinitionModule(
  definition: GeneratedEmailDefinition,
  driverImport: string,
  runtimeEnvImport: string,
  cloudflare: boolean,
  cloudflareEmail: boolean,
): string {
  return [
    `import createDriver from ${JSON.stringify(driverImport)}`,
    `import { resolveServerEnv } from ${JSON.stringify(runtimeEnvImport)}`,
    ...(cloudflare ? ["import { env as vitehubEmailEnv } from \"cloudflare:workers\""] : []),
    ...(cloudflareEmail ? ["import { EmailMessage } from \"cloudflare:email\""] : []),
    "",
    `const registry = ${JSON.stringify(definition.options, null, 2)}`,
    "export const definition = {",
    "  driver: () => {",
    `    const options = resolveServerEnv(registry${cloudflare ? ", { env: vitehubEmailEnv }" : ""})`,
    `    return createDriver(${cloudflareEmail
      ? `{ ...${renderResolvedOptions(definition.options, "options")}, binding: vitehubEmailEnv.EMAIL, EmailMessage }`
      : renderResolvedOptions(definition.options, "options")})`,
    "  },",
    "}",
    "export default definition",
    "",
  ].join("\n")
}

function resolveHosting(options: InternalEmailVitePluginOptions, config: Record<string, unknown>): string | undefined {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const preset = typeof nitro.preset === "string" ? nitro.preset : undefined
  return preset ?? options.hosting ?? process.env.NITRO_PRESET ?? process.env.SERVER_PRESET ?? process.env.VITEHUB_HOSTING
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

function configureNitroCloudflareWorkers(config: Record<string, unknown>, email: boolean): void {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const rollupConfig = isRecord(nitro.rollupConfig) ? nitro.rollupConfig : {}
  const cloudflare = isRecord(nitro.cloudflare) ? nitro.cloudflare : {}
  const wrangler = isRecord(cloudflare.wrangler) ? cloudflare.wrangler : {}
  const compatibilityFlags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
  const sendEmail = Array.isArray(wrangler.send_email) ? [...wrangler.send_email] : []
  if (!compatibilityFlags.includes("nodejs_compat")) compatibilityFlags.push("nodejs_compat")
  if (email && !sendEmail.some(binding => isRecord(binding) && binding.name === "EMAIL")) sendEmail.push({ name: "EMAIL" })
  config.nitro = {
    ...nitro,
    cloudflare: {
      ...cloudflare,
      wrangler: {
        ...wrangler,
        compatibility_flags: compatibilityFlags,
        ...(sendEmail.length ? { send_email: sendEmail } : {}),
      },
    },
    rollupConfig: {
      ...rollupConfig,
      external: email
        ? mergeNitroExternal(mergeNitroExternal(rollupConfig.external, "cloudflare:workers"), "cloudflare:email")
        : mergeNitroExternal(rollupConfig.external, "cloudflare:workers"),
    },
  }
}

export function hubEmail(options: EmailVitePluginOptions): EmailVitePlugin {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] Email requires an unemail/driver/* driver.")
  }
  const internalOptions = options as EmailVitePluginOptions & InternalEmailVitePluginOptions
  const configured = configuredDefinition(options)
  const driverImport = resolveDriverImport(configured.driver)
  const runtimeEnvImport = internalOptions.runtimeEnvImport
    ?? resolve(dirname(resolvePackageImport("@vite-hub/env/package.json")), "dist/server.js")
  let cloudflare = false
  const cloudflareEmail = configured.driver === "unemail/driver/cloudflare-email"
  let definition: GeneratedEmailDefinition | undefined

  return {
    name: EMAIL_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinition: () => definition,
    },
    config(config) {
      cloudflare = getHostingProvider(resolveHosting(internalOptions, config as Record<string, unknown>)) === "cloudflare"
      if (cloudflare) configureNitroCloudflareWorkers(config as Record<string, unknown>, cloudflareEmail)
      return {
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
    },
    async configResolved(config) {
      definition = {
        ...configured,
        handler: resolve(resolveViteHubGeneratedRoot(config), "email/definition.mjs"),
      }
      const entry = definition.handler.replace(/\.mjs$/, ".entry.mjs")
      await writeFileIfChanged(entry, renderConfiguredEmailDefinitionModule(definition, driverImport, runtimeEnvImport, cloudflare, cloudflare && cloudflareEmail))
      try {
        await bundleEsmEntry(entry, definition.handler, {
          external: cloudflare ? ["node:*", "cloudflare:workers", ...(cloudflareEmail ? ["cloudflare:email"] : [])] : undefined,
          format: "esm",
          minifyWhitespace: true,
          platform: cloudflare ? "neutral" : "node",
          rootDir: config.root,
        })
      }
      finally {
        await rm(entry, { force: true })
      }
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    resolveId(id) {
      if (id === EMAIL_DEFINITION_ID) return resolvedEmailDefinitionId
    },
    load(id) {
      if (id === resolvedEmailDefinitionId && definition) {
        return renderEmailDefinitionModule(definition)
      }
    },
  }
}
