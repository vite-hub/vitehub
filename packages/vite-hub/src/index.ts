import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import frameworkPackageManifest from "../package.json" with { type: "json" }

import { hubAgent } from "@vite-hub/agent/vite"
import { hubAuth } from "@vite-hub/auth/vite"
import { hubBlob } from "@vite-hub/blob/vite"
import { hubBrowser } from "@vite-hub/browser/vite"
import { hubChannels } from "@vite-hub/channels/vite"
import { hubDb } from "@vite-hub/database/vite"
import { hubEmail, hubEmailOptionalPeerResolver } from "@vite-hub/email/vite"
import { hubEnv } from "@vite-hub/env/vite"
import { hubKv, hubKvOptionalPeerResolver, resolveKVViteConfig } from "@vite-hub/kv/vite"
import { hubMarkdownTemplate } from "@vite-hub/markdown-template/vite"
import { hubQueue } from "@vite-hub/queue/vite"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { hubRealtime } from "@vite-hub/realtime/vite"
import { hubSandbox } from "@vite-hub/sandbox/vite"
import { hubSchedule } from "@vite-hub/schedule/vite"
import { hubWorkflow } from "@vite-hub/workflow/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { composeNitroCloudflareProviderOutput, registerCloudflareProviderOutput } from "@vite-hub/internal/build/deployment-output"
import { finalizeDeploymentPlanOutput } from "@vite-hub/internal/build/deployment-plan-output"
import { finalizeDenoDeploymentOutput } from "@vite-hub/internal/build/deno-runtime-packages"
import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { assertDeploymentService, deploymentPresetFromNitro, normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"

import { viteHubTypesPlugin } from "./internal/types.ts"
import { consoleInvocationRootPlugin, consoleVitePlugin } from "./console/vite.ts"

import type { AgentModuleOptions } from "@vite-hub/agent"
import type { AuthModuleOptions } from "@vite-hub/auth"
import type { BlobModuleOptions } from "@vite-hub/blob"
import type { BrowserModuleOptions } from "@vite-hub/browser/vite"
import type { ChannelsVitePluginOptions } from "@vite-hub/channels/vite"
import type { DBModulePublicOptions } from "@vite-hub/database"
import type { EmailVitePluginOptions } from "@vite-hub/email/vite"
import type { EnvIntegrationOptions, EnvRuntimeRegistry } from "@vite-hub/env"
import type { EnvVitePlugin } from "@vite-hub/env/vite"
import type { KVModuleOptions } from "@vite-hub/kv"
import type { DeploymentPlan, DeploymentService } from "@vite-hub/internal/deployment"
import type { QueueModuleOptions } from "@vite-hub/queue"
import type { RateLimitModuleOptions } from "@vite-hub/rate-limit"
import type { RealtimeModuleOptions } from "@vite-hub/realtime"
import type { SandboxPublicOptions } from "@vite-hub/sandbox/vite"
import type { ScheduleVitePluginOptions } from "@vite-hub/schedule/vite"
import type { WorkflowModuleOptions } from "@vite-hub/workflow"
import type { WorkspaceModuleOptions } from "@vite-hub/workspace"
import type { Plugin, PluginOption, UserConfig } from "vite"

type FrameworkDependencyName = Extract<keyof typeof frameworkPackageManifest.dependencies, `@vite-hub/${string}`>

const generatedOwnerPackageAccess = {
  "@vite-hub/agent": true,
  "@vite-hub/auth": true,
  "@vite-hub/blob": true,
  "@vite-hub/browser": true,
  "@vite-hub/box": true,
  "@vite-hub/channels": true,
  "@vite-hub/cli": false,
  "@vite-hub/database": true,
  "@vite-hub/email": true,
  "@vite-hub/env": true,
  "@vite-hub/history": true,
  "@vite-hub/kv": true,
  "@vite-hub/markdown-template": true,
  "@vite-hub/queue": true,
  "@vite-hub/rate-limit": true,
  "@vite-hub/realtime": true,
  "@vite-hub/runtime": true,
  "@vite-hub/sandbox": true,
  "@vite-hub/schedule": true,
  "@vite-hub/shell": true,
  "@vite-hub/source": true,
  "@vite-hub/ui": true,
  "@vite-hub/workflow": true,
  "@vite-hub/workspace": true,
} satisfies Record<FrameworkDependencyName, boolean>

const generatedOwnerPackageNames = Object.entries(generatedOwnerPackageAccess)
  .filter(([, allowed]) => allowed)
  .map(([name]) => name)

const frameworkVirtualImporters = new Set([
  "\0#vitehub/auth/server",
  "\0#vitehub/env/server",
  "\0#vitehub/schedule/registry",
  "\0virtual:vitehub-agent-cloudflare-state-exports",
])

const frameworkPackageName = "vite-hub"
const generatedImportBase = "vite-hub/_internal"
const upstashDriverSpecifier = "@vite-hub/kv/runtime/upstash-driver"
const disabledUpstashDriver = fileURLToPath(import.meta.resolve(`${generatedImportBase}/kv/runtime/disabled-upstash`))
function frameworkWorkspaceDependencyRuntimeImports(sandbox: boolean) {
  return {
    ...(sandbox
      ? {
          sandbox: "vite-hub/sandbox",
          sandboxRuntimeState: `${generatedImportBase}/sandbox/runtime/state`,
        }
      : {}),
    shellWorkspace: "vite-hub/shell/workspace",
  }
}
const frameworkProviderImportAliases = Object.fromEntries(
  Object.entries(frameworkPackageManifest.exports)
    .filter(([subpath, target]) => subpath.startsWith("./") && target.endsWith(".js"))
    .map(([subpath]) => {
      const specifier = `${frameworkPackageName}/${subpath.slice(2)}`
      return [specifier, fileURLToPath(import.meta.resolve(specifier))]
    })
    .sort(([left], [right]) => right.length - left.length),
)

function isGeneratedImporter(importer: string | undefined) {
  const normalized = importer?.replace(/\\/g, "/")
  return Boolean(normalized && (/(?:^|\/)\.vitehub(?:\/|$)/.test(normalized) || frameworkVirtualImporters.has(normalized)))
}

function hasUpstashStore(kv: ReturnType<typeof resolveKVViteConfig>["kv"]): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "upstash")
}

function configureProviderOptionalImportAliases(
  aliases: Record<string, string>,
  options: ViteHubOptions,
  configuredKV?: KVModuleOptions,
) {
  const kv = options.kv
    ? resolveKVViteConfig(configuredKV ?? (options.kv === true ? undefined : options.kv)).kv
    : false
  if (hasUpstashStore(kv)) delete aliases[upstashDriverSpecifier]
  else aliases[upstashDriverSpecifier] = disabledUpstashDriver
}

function frameworkDependencyResolver(
  options: ViteHubOptions,
  providerImportAliases: Record<string, string>,
  blobEnabled: boolean,
  presetKVOptions?: KVModuleOptions,
): Plugin {
  return {
    name: "vite-hub/dependencies",
    enforce: "pre",
    config() {
      const aliases = { ...frameworkProviderImportAliases }
      if (!blobEnabled) delete aliases["vite-hub/blob"]
      return {
        resolve: {
          alias: aliases,
        },
      }
    },
    configResolved(config) {
      configureProviderOptionalImportAliases(
        providerImportAliases,
        options,
        (config as typeof config & { kv?: KVModuleOptions }).kv ?? presetKVOptions,
      )
    },
    resolveId(id, importer) {
      if (!blobEnabled && id === "@vite-hub/blob") {
        throw new Error("[vitehub] Blob is unavailable for this deployment preset. Configure an explicit Blob store before using Blob APIs or Agent Capabilities.")
      }
      for (const specifier in providerImportAliases) {
        const frameworkFacade = frameworkProviderImportAliases[specifier]
        if (!frameworkFacade) continue
        const providerFacade = providerImportAliases[specifier]
        if (id === frameworkFacade || providerImportAliases[id] === providerFacade) return providerFacade
      }
      if (!isGeneratedImporter(importer)) return
      const isFrameworkPackageImport = id === frameworkPackageName || id.startsWith(`${frameworkPackageName}/`)
      const isOwnerPackageImport = generatedOwnerPackageNames.some(name => id === name || id.startsWith(`${name}/`))
      if (!isFrameworkPackageImport && !isOwnerPackageImport) return
      return fileURLToPath(import.meta.resolve(id))
    },
  }
}

export interface ViteHubOptions {
  preset: DeploymentPreset
  name?: string
  agent?: boolean | AgentModuleOptions
  auth?: true | AuthModuleOptions
  blob?: boolean | BlobModuleOptions
  browser?: boolean | BrowserModuleOptions
  channels?: boolean | ChannelsVitePluginOptions
  console?: boolean
  database?: boolean | DBModulePublicOptions
  email?: true | EmailVitePluginOptions
  env?: false | EnvIntegrationOptions
  kv?: boolean | KVModuleOptions
  queue?: boolean
  rateLimit?: boolean
  realtime?: boolean | RealtimeModuleOptions
  sandbox?: boolean
  schedule?: boolean | ScheduleVitePluginOptions
  workflow?: boolean | WorkflowModuleOptions
  workspace?: boolean | WorkspaceModuleOptions
}

export type DeploymentPreset = "cloudflare" | "deno" | "netlify" | "node" | "vercel"

export interface ViteHubConfig {
  preset?: DeploymentPreset
}

type DeploymentIdentitySource = "WRANGLER_CI_OVERRIDE_NAME" | "package.json" | "root" | "vitehub.name"

interface DeploymentIdentity {
  name: string
  source: DeploymentIdentitySource
}

function normalizeDeploymentName(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || undefined
}

function cloudflareResourceScope(name: string): string {
  return name.slice(0, 48).replace(/-+$/g, "")
}

function cloudflareR2BucketName(name: string): string {
  const scoped = cloudflareResourceScope(name)
  return scoped.length >= 3 ? scoped : `${scoped || "app"}-blob`
}

function packageName(root?: string): string | undefined {
  let directory = resolve(process.cwd(), root || ".")
  while (true) {
    const manifestPath = join(directory, "package.json")
    if (existsSync(manifestPath)) {
      const name = JSON.parse(readFileSync(manifestPath, "utf8")).name
      if (typeof name === "string" && name.trim()) return name
    }
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

function resolveDeploymentIdentity(
  root: string | undefined,
  configuredName: string | undefined,
  workersBuildsName?: string,
): DeploymentIdentity {
  const configured = normalizeDeploymentName(configuredName)
  if (configuredName !== undefined && !configured) {
    throw new Error("[vitehub] vitehub name must contain at least one letter or number.")
  }
  const workersBuilds = normalizeDeploymentName(workersBuildsName)
  if (workersBuildsName?.trim() && !workersBuilds) {
    throw new Error("[vitehub] WRANGLER_CI_OVERRIDE_NAME must contain at least one letter or number.")
  }
  if (configured && workersBuilds && configured !== workersBuilds) {
    throw new Error(`[vitehub] deployment identity ${JSON.stringify(configured)} conflicts with WRANGLER_CI_OVERRIDE_NAME=${JSON.stringify(workersBuildsName)}.`)
  }
  if (configured) return { name: configured, source: "vitehub.name" }
  if (workersBuilds) return { name: workersBuilds, source: "WRANGLER_CI_OVERRIDE_NAME" }
  const manifestName = normalizeDeploymentName(packageName(root))
  if (manifestName) return { name: manifestName, source: "package.json" }
  return {
    name: normalizeDeploymentName(basename(resolve(process.cwd(), root || "."))) || "vitehub",
    source: "root",
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function requiredCloudflareSecretNames(registry: EnvRuntimeRegistry): string[] {
  const names = new Set<string>()
  const visit = (value: unknown): void => {
    const entry = cloneRecord(value)
    const source = cloneRecord(entry.source)
    if (source.kind === "env" && typeof source.name === "string") {
      const sources = Array.isArray(source.names) ? source.names : [source.name]
      if (
        entry.required === true
        && entry.secret === true
        && entry.default === undefined
        && sources.length === 1
        && typeof sources[0] === "string"
      ) names.add(sources[0])
      return
    }
    if (entry.kind === "literal") return
    for (const child of Object.values(entry)) visit(child)
  }
  for (const value of Object.values(registry)) visit(value)
  return [...names]
}

function findEnvPlugin(options: unknown): EnvVitePlugin | undefined {
  if (Array.isArray(options)) {
    for (const option of options) {
      const plugin = findEnvPlugin(option)
      if (plugin) return plugin
    }
    return
  }
  if (!options || typeof options !== "object") return
  const plugin = options as Partial<EnvVitePlugin>
  return plugin.name === "@vite-hub/env/vite" && typeof plugin.api?.getServerEnvRegistry === "function"
    ? plugin as EnvVitePlugin
    : undefined
}

function matchesRollupExternal(value: unknown, source: string, args: unknown[]): boolean {
  if (typeof value === "string") return value === source
  if (value instanceof RegExp) {
    value.lastIndex = 0
    return value.test(source)
  }
  if (typeof value === "function") return Boolean(value(source, ...args))
  if (Array.isArray(value)) return value.some(entry => matchesRollupExternal(entry, source, args))
  return false
}

function configureCloudflarePrerender(config: Record<string, unknown>): void {
  const rollupConfig = cloneRecord(config.rollupConfig)
  const external = rollupConfig.external
  const prerenderImports = new Set(["cloudflare:email", "cloudflare:workers"])
  if (typeof external !== "undefined") {
    rollupConfig.external = (source: string, ...args: unknown[]) =>
      prerenderImports.has(source) ? false : matchesRollupExternal(external, source, args)
  }
  config.alias = {
    ...cloneRecord(config.alias),
    "cloudflare:email": fileURLToPath(new URL("./cloudflare-prerender.mjs", import.meta.url)),
    "cloudflare:workers": fileURLToPath(new URL("./cloudflare-prerender.mjs", import.meta.url)),
  }
  config.rollupConfig = rollupConfig
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function deploymentNitroModule(
  plan: DeploymentPlan,
  services: object,
  identity: DeploymentIdentity,
  sandboxRequested: boolean,
  isDeployCommandOwned: () => boolean,
) {
  return (nitro: {
    hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
    options: { commands: Record<string, unknown>, output: { dir: string, serverDir: string }, preset?: string, rootDir: string }
  }) => {
    if (deploymentPresetFromNitro(nitro.options.preset) !== plan.preset) return
    if (plan.preset === "cloudflare" && sandboxRequested && !isDeployCommandOwned()) {
      const outputRelative = relative(nitro.options.output.dir, nitro.options.output.serverDir).replaceAll("\\", "/")
      const serverDir = /^[\w./-]+$/.test(outputRelative)
        ? `./${outputRelative}`
        : shellQuote(`./${outputRelative}`)
      nitro.options.commands.deploy = `npx wrangler --cwd ${serverDir} deploy --containers-rollout=gradual`
    }
    nitro.hooks.hook("compiled", async () => {
      const outputDir = nitro.options.output.dir
      const rootDir = nitro.options.rootDir
      if (plan.output.packaging === "deno-node-modules") {
        await finalizeDenoDeploymentOutput({ deploymentName: identity.name, outputDir, rootDir })
      }
      await finalizeDeploymentPlanOutput({ identity, outputDir, plan, rootDir, services })
    })
  }
}

function deploymentPlugins(
  plan: DeploymentPlan,
  requestedServices: DeploymentService[],
  blobEnabled: boolean,
  services: object,
  options: ViteHubOptions,
  envPlugin: EnvVitePlugin | undefined,
): Plugin[] {
  let deployCommandOwned = false
  const deploymentEnvPlugin = { current: envPlugin }
  const subscribedEnvPlugins = new WeakSet<EnvVitePlugin>()
  const subscribeEnvPlugin = (plugin: EnvVitePlugin): void => {
    deploymentEnvPlugin.current = plugin
    if (subscribedEnvPlugins.has(plugin) || plan.preset !== "cloudflare") return
    subscribedEnvPlugins.add(plugin)
    plugin.api.onServerEnvRegistry((registry: EnvRuntimeRegistry, config: UserConfig) => {
      if (cloneRecord((config as { vitehub?: unknown }).vitehub).preset !== plan.preset) return
      registerCloudflareProviderOutput(config, "env", {
        requiredSecrets: requiredCloudflareSecretNames(registry),
      })
      const viteConfig = config as typeof config & { nitro?: unknown }
      viteConfig.nitro = composeNitroCloudflareProviderOutput(config, viteConfig.nitro)
    })
  }
  if (envPlugin) subscribeEnvPlugin(envPlugin)
  const nitroPreset = plan.preset === "cloudflare" && options.realtime ? "cloudflare-durable" : plan.nitroPreset
  return [
    {
      name: "vite-hub/deployment-preset",
      enforce: "pre",
      resolveId(source) {
        if (!blobEnabled && (source === "vite-hub/blob" || source === frameworkProviderImportAliases["vite-hub/blob"])) {
          if (!plan.services.blob.supported) assertDeploymentService(plan, "blob")
          throw new Error("[vitehub] Blob is disabled but the application imports " + JSON.stringify(source) + ".")
        }
      },
      config(config, environment) {
        const building = environment.command === "build"
        ;(config as { vitehub?: unknown }).vitehub = {
          ...cloneRecord((config as { vitehub?: unknown }).vitehub),
          preset: plan.preset,
        }
        for (const service of requestedServices) assertDeploymentService(plan, service)
        const identity = resolveDeploymentIdentity(
          typeof config.root === "string" ? config.root : undefined,
          options.name,
          plan.preset === "cloudflare" ? process.env.WRANGLER_CI_OVERRIDE_NAME : undefined,
        )
        const name = identity.name
        if (requestedServices.includes("queue") && plan.services.queue.supported) {
          ;(config as { queue?: unknown }).queue = {
            ...cloneRecord((config as { queue?: unknown }).queue),
            provider: plan.services.queue.adapter,
            ...(plan.services.queue.adapter === "cloudflare" ? { namePrefix: `${name}-` } : {}),
          }
        }
        if (requestedServices.includes("rateLimit") && plan.services.rateLimit.supported) {
          ;(config as { rateLimit?: unknown }).rateLimit = {
            ...cloneRecord((config as { rateLimit?: unknown }).rateLimit),
            namespace: name,
            provider: plan.services.rateLimit.adapter,
          }
        }
        if (requestedServices.includes("sandbox") && plan.services.sandbox.supported) {
          ;(config as { sandbox?: unknown }).sandbox = {
            ...cloneRecord((config as { sandbox?: unknown }).sandbox),
            ...(plan.services.sandbox.adapter === "cloudflare"
              ? { name: cloudflareResourceScope(name) + "-sandbox" }
              : {}),
            provider: plan.services.sandbox.adapter,
          }
        }
        let nitro = cloneRecord((config as { nitro?: unknown }).nitro)
        if (blobEnabled && plan.services.blob.supported && plan.services.blob.adapter === "cloudflare-r2") {
          const optionBlob = options.blob === true ? undefined : options.blob
          const configuredBlob = (config as { blob?: BlobModuleOptions }).blob
          if (!hasExplicitBlobStore(optionBlob) && !hasExplicitBlobStore(configuredBlob)) {
            ;(config as { blob?: BlobModuleOptions }).blob = presetBlobOptions(plan, {
              ...cloneRecord(optionBlob),
              ...cloneRecord(configuredBlob),
            }, cloudflareR2BucketName(name))
          }
        }
        if (plan.preset === "cloudflare") {
          const wasm = cloneRecord(nitro.wasm)
          if (wasm.lazy === undefined) wasm.lazy = true
          nitro.wasm = wasm
          const cloudflare = cloneRecord(nitro.cloudflare)
          const wrangler = cloneRecord(cloudflare.wrangler)
          if (typeof wrangler.name !== "string") wrangler.name = cloudflareResourceScope(name)
          if (options.realtime) {
            const durableObjects = cloneRecord(wrangler.durable_objects)
            const bindings = Array.isArray(durableObjects.bindings) ? durableObjects.bindings : []
            if (!bindings.some(binding => cloneRecord(binding).name === "$DurableObject")) {
              durableObjects.bindings = [...bindings, { class_name: "$DurableObject", name: "$DurableObject" }]
            }
            const migrations = Array.isArray(wrangler.migrations) ? wrangler.migrations : []
            if (!migrations.some(migration => cloneRecord(migration).tag === "vitehub-realtime-v1")) {
              wrangler.migrations = [...migrations, { new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" }]
            }
            wrangler.durable_objects = durableObjects
          }
          cloudflare.wrangler = wrangler
          nitro.cloudflare = cloudflare
          const hooks = cloneRecord(nitro.hooks)
          const prerenderConfig = hooks["prerender:config"]
          hooks["prerender:config"] = async (config: Record<string, unknown>) => {
            if (typeof prerenderConfig === "function") await prerenderConfig(config)
            configureCloudflarePrerender(config)
          }
          nitro.hooks = hooks
        }
        const configuredPreset = typeof nitro.preset === "string" ? nitro.preset : undefined
        const configuredHosting = process.env.VITEHUB_HOSTING
        if (configuredHosting && deploymentPresetFromNitro(configuredHosting) !== plan.preset) {
          throw new Error("[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with VITEHUB_HOSTING=" + JSON.stringify(configuredHosting) + ".")
        }
        if (building) {
          if (configuredPreset && normalizeNitroPreset(configuredPreset) !== nitroPreset) {
            throw new Error("[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with nitro.preset " + JSON.stringify(configuredPreset) + ".")
          }
          for (const name of ["NITRO_PRESET", "SERVER_PRESET"] as const) {
            const value = process.env[name]
            if (value && normalizeNitroPreset(value) !== nitroPreset) {
              throw new Error("[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with " + name + "=" + JSON.stringify(value) + ".")
            }
          }
          nitro.modules = [
            deploymentNitroModule(plan, services, identity, requestedServices.includes("sandbox"), () => deployCommandOwned),
            ...(Array.isArray(nitro.modules) ? nitro.modules : []),
          ]
          if (plan.output.packaging === "deno-node-modules") {
            nitro.commands = { ...cloneRecord(nitro.commands), deploy: "node ./deploy.mjs" }
            const rollupConfig = cloneRecord(nitro.rollupConfig)
            const output = Array.isArray(rollupConfig.output)
              ? rollupConfig.output.map(options => ({ ...cloneRecord(options), entryFileNames: "index.mjs" }))
              : { ...cloneRecord(rollupConfig.output), entryFileNames: "index.mjs" }
            nitro.rollupConfig = {
              ...rollupConfig,
              output,
            }
          }
          nitro.preset = nitroPreset
        }
        if (plan.preset === "cloudflare") {
          deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
          if (deploymentEnvPlugin.current) {
            subscribeEnvPlugin(deploymentEnvPlugin.current)
            const envConfig = (config as { env?: { server?: Parameters<EnvVitePlugin["api"]["createServerEnvRegistry"]>[0] } }).env
            registerCloudflareProviderOutput(config, "env", {
              requiredSecrets: requiredCloudflareSecretNames(deploymentEnvPlugin.current.api.createServerEnvRegistry(envConfig?.server)),
            })
            nitro = composeNitroCloudflareProviderOutput(config, nitro)
          }
        }
        ;(config as { nitro?: unknown }).nitro = nitro
      },
    },
    {
      name: "vite-hub/deployment-output",
      enforce: "post",
      vitehub: {
        deploymentOutput: {
          useEnvPlugin(plugin: EnvVitePlugin) {
            subscribeEnvPlugin(plugin)
          },
        },
      },
      config(config) {
        deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
        if (deploymentEnvPlugin.current) subscribeEnvPlugin(deploymentEnvPlugin.current)
        if (plan.preset !== "cloudflare") return
        if ((config as { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean })[VITEHUB_NITRO_CONFIG_CONTEXT] === true) {
          const viteConfig = config as { nitro?: unknown }
          viteConfig.nitro = composeNitroCloudflareProviderOutput(config, viteConfig.nitro)
        }
      },
      configResolved(config) {
        if (plan.preset === "cloudflare") {
          deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
          if (deploymentEnvPlugin.current) subscribeEnvPlugin(deploymentEnvPlugin.current)
          const viteConfig = config as typeof config & { nitro?: unknown }
          viteConfig.nitro = composeNitroCloudflareProviderOutput(config, viteConfig.nitro)
        }
        const nitro = cloneRecord((config as { nitro?: unknown }).nitro)
        deployCommandOwned = typeof cloneRecord(nitro.commands).deploy === "string"
        if (config.command === "build" && nitro.preset !== nitroPreset) {
          throw new Error("[vitehub] The " + JSON.stringify(plan.preset) + " deployment plan requires Nitro preset " + JSON.stringify(nitroPreset) + ".")
        }
      },
    } as Plugin,
  ]
}

function hasExplicitBlobStore(options: boolean | BlobModuleOptions | undefined): boolean {
  return Boolean(options && typeof options === "object" && ("driver" in options || "stores" in options))
}

function presetBlobOptions(
  plan: DeploymentPlan,
  options: boolean | BlobModuleOptions | undefined,
  deploymentName = "vitehub-blob",
): BlobModuleOptions {
  if (hasExplicitBlobStore(options)) return options as BlobModuleOptions
  const configured = options && typeof options === "object" ? options : {}
  switch (plan.services.blob.supported && plan.services.blob.adapter) {
    case "cloudflare-r2": return {
      bucketName: process.env.BLOB_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET_NAME || process.env.R2_BUCKET_NAME || deploymentName,
      ...configured,
      driver: "cloudflare-r2",
    }
    case "fs": return { ...configured, driver: "fs" }
    case "netlify-blobs": return { name: "vitehub-blob", ...configured, driver: "netlify-blobs" }
    case "vercel-blob": return { ...configured, driver: "vercel-blob" }
    default: throw new Error("[vitehub] Missing Blob adapter for deployment preset " + JSON.stringify(plan.preset) + ".")
  }
}

export function vitehub(options: ViteHubOptions): PluginOption[] {
  if (!options || typeof options !== "object") throw new TypeError("vitehub() requires a built-in deployment preset.")
  const plan = resolveDeploymentPlan(options.preset)
  if (options.schedule && plan.preset === "deno") {
    throw new Error("[vitehub] The \"deno\" preset cannot provide Schedule because its generated cron output is not part of the deployed Nitro entrypoint. Disable Schedule or compose an explicit Deno scheduling integration.")
  }
  if (options.agent && options.agent !== true && options.agent.runtime === "deno" && plan.preset === "deno") {
    throw new Error("[vitehub] The \"deno\" preset cannot deploy the Agent Deno runtime because its generated server is outside the deployed Nitro entrypoint. Use the preset's Nitro runtime or compose an explicit Deno Agent deployment.")
  }
  if (options.browser && plan.preset !== "cloudflare") {
    throw new Error("[vitehub] Browser currently requires the Cloudflare deployment preset.")
  }
  if (options.email === true && plan.preset !== "cloudflare") {
    throw new Error("[vitehub] email: true currently requires the Cloudflare deployment preset; configure an explicit Email driver for other presets.")
  }
  const sandboxEnabled = options.sandbox === true && plan.services.sandbox.supported
  const blobEnabled = Boolean(options.blob) && (plan.services.blob.supported || hasExplicitBlobStore(options.blob))
  const workflowEnabled = options.workflow !== false && Boolean(options.agent || options.workflow)
  const plugins: unknown[] = []
  const requestedServices: DeploymentService[] = []
  if (options.blob !== undefined && options.blob !== false && !hasExplicitBlobStore(options.blob)) requestedServices.push("blob")
  if (options.queue) requestedServices.push("queue")
  if (options.rateLimit) requestedServices.push("rateLimit")
  if (options.sandbox) requestedServices.push("sandbox")
  const manifestServices = hasExplicitBlobStore(options.blob)
    ? { ...plan.services, blob: { configured: true, supported: true } }
    : plan.services
  const envPlugin = options.env === false
    ? undefined
    : hubEnv({
        ...options.env,
        runtimeImports: {
          secret: "vite-hub/env/secret",
          server: "vite-hub/env/server",
          ...options.env?.runtimeImports,
        },
      })
  plugins.push(...deploymentPlugins(plan, requestedServices, blobEnabled, manifestServices, options, envPlugin))
  const providerImportAliases: Record<string, string> = {}
  const configuredKV = options.kv && options.kv !== true ? options.kv : undefined
  const presetKV = options.kv ? resolveKVViteConfig(configuredKV, { hosting: plan.nitroPreset }).kv : false
  const presetKVOptions = presetKV && (presetKV.stores ? { stores: presetKV.stores } : presetKV.store)
  configureProviderOptionalImportAliases(providerImportAliases, options, presetKVOptions || undefined)
  const workspaceDependencyRuntimeImports = frameworkWorkspaceDependencyRuntimeImports(sandboxEnabled)

  plugins.push(frameworkDependencyResolver(options, providerImportAliases, blobEnabled, presetKVOptions || undefined))
  plugins.push(hubMarkdownTemplate({ runtimeImport: `${generatedImportBase}/markdown-template` }))

  if (envPlugin) plugins.push(envPlugin)

  if (options.console) {
    plugins.push(consoleVitePlugin({ preset: plan.preset }), consoleInvocationRootPlugin())
  }

  if (options.auth) {
    plugins.push(hubAuth(
      options.auth === true ? {} : options.auth,
      {
      importBase: "vite-hub/auth",
      },
    ))
  }
  if (sandboxEnabled) {
    const sandboxPolicy = plan.services.sandbox
    plugins.push(hubSandbox({
      ...(sandboxPolicy.supported ? { provider: sandboxPolicy.adapter } : {}),
      providerImportAliases,
      providerImportSpecifier: "vite-hub/sandbox",
    } as SandboxPublicOptions))
  }
  if (options.agent) {
    const agentOptions = options.agent === true ? {} : options.agent
    plugins.push(hubAgent({
      ...agentOptions,
      cloudflareStateImport: `${generatedImportBase}/agent/cloudflare/state`,
      importBase: `${generatedImportBase}/agent`,
      processDiscordGateway: plan.preset === "node",
      providerImportAliases,
      runtimeCapabilityImports: {
        blob: blobEnabled ? `${generatedImportBase}/blob` : false,
        db: options.database ? "vite-hub/database/drizzle" : false,
        email: "vite-hub/email/server",
        kv: `${generatedImportBase}/kv`,
      },
      scheduleRuntimeImport: `${generatedImportBase}/schedule/runtime`,
      workflowImportBase: `${generatedImportBase}/workflow`,
      workspaceDependencyRuntimeImports,
      workspaceImportBase: `${generatedImportBase}/workspace`,
    } as AgentModuleOptions))
  }
  if (options.browser) plugins.push(hubBrowser(options.browser === true ? undefined : options.browser))
  if (options.channels) plugins.push(hubChannels(options.channels === true ? undefined : options.channels))
  if (options.database) plugins.push(hubDb(options.database === true ? undefined : options.database))
  if (blobEnabled) {
    plugins.push(hubBlob(
      presetBlobOptions(plan, options.blob),
      {
      importBase: `${generatedImportBase}/blob`,
      nitroOwned: true,
      },
    ))
  }
  if (options.email) {
    const emailOptions = options.email === true
      ? { driver: "unemail/driver/cloudflare-email" as const }
      : options.email
    plugins.push(hubEmail({
      ...emailOptions,
      hosting: plan.nitroPreset,
      runtimeEnvImport: "vite-hub/env/server",
      workflowProvider: options.workflow && options.workflow !== true ? options.workflow.provider : undefined,
    } as EmailVitePluginOptions))
  }
  else plugins.push(hubEmailOptionalPeerResolver())
  if (options.kv) {
    plugins.push(hubKv(presetKVOptions || undefined))
  }
  else plugins.push(hubKvOptionalPeerResolver())
  if (options.queue && plan.services.queue.supported) {
    plugins.push(hubQueue({
      provider: plan.services.queue.adapter,
      providerImportAliases,
    } as QueueModuleOptions))
  }
  if (options.rateLimit) {
    const rateLimitPolicy = plan.services.rateLimit
    plugins.push(hubRateLimit({
      provider: rateLimitPolicy.supported ? rateLimitPolicy.adapter : "memory",
      importBase: `${generatedImportBase}/rate-limit`,
    } as RateLimitModuleOptions))
  }
  if (options.realtime) {
    plugins.push(hubRealtime({
      ...(options.realtime === true ? {} : options.realtime),
      importBase: "vite-hub/realtime",
    }))
  }
  if (options.schedule) {
    plugins.push(hubSchedule({
      ...(plan.preset === "vercel" ? { providerOutput: "standalone" as const } : {}),
      ...(options.schedule === true ? {} : options.schedule),
      importBase: `${generatedImportBase}/schedule`,
      providerImportAliases,
      runtimeImport: `${generatedImportBase}/schedule/runtime/static`,
    } as ScheduleVitePluginOptions))
  }
  if (workflowEnabled) {
    plugins.push(hubWorkflow(
      options.workflow && options.workflow !== true ? options.workflow : {},
      {
      agentImportBase: `${generatedImportBase}/agent`,
      hosting: plan.nitroPreset,
      importBase: `${generatedImportBase}/workflow`,
      ...(options.workflow === undefined ? { implicitlyEnabled: true } : {}),
      providerImportAliases,
      includeUserAppEntry: options.workflow !== undefined && options.workflow !== false,
      workspaceDependencyRuntimeImports,
      workspaceImportBase: `${generatedImportBase}/workspace`,
      },
    ))
  }
  if (options.workspace) {
    plugins.push(hubWorkspace({
      ...(options.workspace === true ? {} : options.workspace),
      hosting: plan.nitroPreset,
      importBase: `${generatedImportBase}/workspace`,
    } as WorkspaceModuleOptions))
  }
  plugins.push(viteHubTypesPlugin())
  return plugins as PluginOption[]
}

declare module "vite" {
  interface UserConfig {
    vitehub?: ViteHubConfig
  }
}
