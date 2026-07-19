import { fileURLToPath } from "node:url"

import frameworkPackageManifest from "../package.json" with { type: "json" }

import { hubAgent } from "@vite-hub/agent/vite"
import { hubAuth } from "@vite-hub/auth/vite"
import { hubBlob } from "@vite-hub/blob/vite"
import { hubDb } from "@vite-hub/database/vite"
import { hubDevtools } from "@vite-hub/devtools"
import { hubEmail } from "@vite-hub/email/vite"
import { hubEnv } from "@vite-hub/env/vite"
import { hubKv, hubKvOptionalPeerResolver, resolveKVViteConfig } from "@vite-hub/kv/vite"
import { hubMarkdownTemplate } from "@vite-hub/markdown-template/vite"
import { hubQueue } from "@vite-hub/queue/vite"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { hubSandbox } from "@vite-hub/sandbox/vite"
import { hubSchedule } from "@vite-hub/schedule/vite"
import { hubWorkflow } from "@vite-hub/workflow/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"

import type { AgentModuleOptions } from "@vite-hub/agent"
import type { AuthModuleOptions } from "@vite-hub/auth"
import type { BlobModuleOptions } from "@vite-hub/blob"
import type { DBModulePublicOptions } from "@vite-hub/database"
import type { HubDevtoolsOptions } from "@vite-hub/devtools"
import type { EmailVitePluginOptions } from "@vite-hub/email/vite"
import type { EnvIntegrationOptions } from "@vite-hub/env"
import type { KVModuleOptions } from "@vite-hub/kv"
import type { QueueModuleOptions } from "@vite-hub/queue"
import type { RateLimitModuleOptions } from "@vite-hub/rate-limit"
import type { SandboxPublicOptions } from "@vite-hub/sandbox/vite"
import type { ScheduleVitePluginOptions } from "@vite-hub/schedule/vite"
import type { WorkflowModuleOptions } from "@vite-hub/workflow"
import type { WorkspaceModuleOptions } from "@vite-hub/workspace"
import type { Plugin, PluginOption } from "vite"

type FrameworkDependencyName = Extract<keyof typeof frameworkPackageManifest.dependencies, `@vite-hub/${string}`>

const generatedOwnerPackageAccess = {
  "@vite-hub/agent": true,
  "@vite-hub/auth": true,
  "@vite-hub/blob": true,
  "@vite-hub/box": true,
  "@vite-hub/cli": false,
  "@vite-hub/database": true,
  "@vite-hub/devtools": true,
  "@vite-hub/email": true,
  "@vite-hub/env": true,
  "@vite-hub/kv": true,
  "@vite-hub/markdown-template": true,
  "@vite-hub/queue": true,
  "@vite-hub/rate-limit": true,
  "@vite-hub/runtime": true,
  "@vite-hub/sandbox": true,
  "@vite-hub/schedule": true,
  "@vite-hub/shell": true,
  "@vite-hub/source": true,
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
  "\0#vitehub/templates",
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
  Object.keys(frameworkPackageManifest.exports)
    .filter(subpath => subpath.startsWith("./") && subpath !== "./package.json")
    .map((subpath) => {
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
  options: ViteHubPresetOptions,
  configuredKV?: KVModuleOptions,
) {
  const kv = options.kv
    ? resolveKVViteConfig(configuredKV ?? (options.kv === true ? undefined : options.kv)).kv
    : false
  if (hasUpstashStore(kv)) delete aliases[upstashDriverSpecifier]
  else aliases[upstashDriverSpecifier] = disabledUpstashDriver
}

function frameworkDependencyResolver(
  options: ViteHubPresetOptions,
  providerImportAliases: Record<string, string>,
): Plugin {
  return {
    name: "vite-hub/dependencies",
    enforce: "pre",
    config() {
      return {
        resolve: {
          alias: frameworkProviderImportAliases,
        },
      }
    },
    configResolved(config) {
      configureProviderOptionalImportAliases(
        providerImportAliases,
        options,
        (config as typeof config & { kv?: KVModuleOptions }).kv,
      )
    },
    resolveId(id, importer) {
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

export interface ViteHubPresetOptions {
  agent?: false | AgentModuleOptions
  auth?: true | AuthModuleOptions
  blob?: false | BlobModuleOptions
  database?: false | DBModulePublicOptions
  devtools?: false | HubDevtoolsOptions
  email?: boolean | EmailVitePluginOptions
  env?: false | EnvIntegrationOptions
  kv?: boolean | KVModuleOptions
  queue?: boolean | QueueModuleOptions
  rateLimit?: boolean | RateLimitModuleOptions
  sandbox?: boolean | SandboxPublicOptions
  schedule?: boolean | ScheduleVitePluginOptions
  workflow?: false | WorkflowModuleOptions
  workspace?: false | WorkspaceModuleOptions
}

export function vitehub(options: ViteHubPresetOptions = {}): PluginOption[] {
  const plugins: unknown[] = []
  const providerImportAliases: Record<string, string> = {}
  configureProviderOptionalImportAliases(providerImportAliases, options)
  const workspaceDependencyRuntimeImports = frameworkWorkspaceDependencyRuntimeImports(options.sandbox !== false)

  plugins.push(frameworkDependencyResolver(options, providerImportAliases))
  plugins.push(hubMarkdownTemplate({ runtimeImport: `${generatedImportBase}/markdown-template` }))

  if (options.env !== false) {
    const envOptions = options.env ?? {}
    plugins.push(hubEnv({
      ...envOptions,
      runtimeImports: {
        secret: "vite-hub/env/secret",
        server: "vite-hub/env/server",
        ...envOptions.runtimeImports,
      },
    }))
  }

  if (options.auth) {
    plugins.push(hubAuth({
      ...(options.auth === true ? {} : options.auth),
      importBase: "vite-hub/auth",
    } as unknown as AuthModuleOptions))
  }
  if (options.sandbox !== false) {
    plugins.push(hubSandbox({
      ...(options.sandbox === true || options.sandbox === undefined ? {} : options.sandbox),
      providerImportAliases,
      providerImportSpecifier: "vite-hub/sandbox",
    } as unknown as SandboxPublicOptions))
  }
  if (options.agent !== false) {
    plugins.push(hubAgent({
      ...options.agent,
      cloudflareStateImport: `${generatedImportBase}/agent/cloudflare/state`,
      importBase: `${generatedImportBase}/agent`,
      providerImportAliases,
      runtimeCapabilityImports: {
        blob: `${generatedImportBase}/blob`,
        email: "vite-hub/email/server",
        kv: `${generatedImportBase}/kv`,
      },
      scheduleRuntimeImport: `${generatedImportBase}/schedule/runtime`,
      workflowImportBase: `${generatedImportBase}/workflow`,
      workspaceDependencyRuntimeImports,
      workspaceImportBase: `${generatedImportBase}/workspace`,
    } as AgentModuleOptions))
  }
  if (options.database !== false) plugins.push(hubDb(options.database))
  if (options.blob !== false) {
    plugins.push(hubBlob({
      ...options.blob,
      importBase: `${generatedImportBase}/blob`,
    } as unknown as BlobModuleOptions))
  }
  if (options.email) plugins.push(hubEmail(options.email === true ? undefined : options.email))
  if (options.kv) plugins.push(hubKv(options.kv === true ? undefined : options.kv))
  else plugins.push(hubKvOptionalPeerResolver())
  if (options.queue) plugins.push(hubQueue(options.queue === true ? {} : options.queue))
  if (options.rateLimit) {
    plugins.push(hubRateLimit({
      ...(options.rateLimit === true ? {} : options.rateLimit),
      importBase: `${generatedImportBase}/rate-limit`,
    } as RateLimitModuleOptions))
  }
  if (options.schedule) {
    plugins.push(hubSchedule({
      ...(options.schedule === true ? {} : options.schedule),
      importBase: `${generatedImportBase}/schedule`,
      providerImportAliases,
      runtimeImport: `${generatedImportBase}/schedule/runtime/static`,
    } as ScheduleVitePluginOptions))
  }
  if (options.workflow !== false) {
    plugins.push(hubWorkflow({
      ...options.workflow,
      agentImportBase: `${generatedImportBase}/agent`,
      importBase: `${generatedImportBase}/workflow`,
      providerImportAliases,
      workspaceDependencyRuntimeImports,
      workspaceImportBase: `${generatedImportBase}/workspace`,
    } as unknown as WorkflowModuleOptions))
  }
  if (options.workspace !== false) {
    plugins.push(hubWorkspace({
      ...options.workspace,
      importBase: `${generatedImportBase}/workspace`,
    } as WorkspaceModuleOptions))
  }
  if (options.devtools !== false) plugins.push(hubDevtools(options.devtools))

  return plugins as PluginOption[]
}
