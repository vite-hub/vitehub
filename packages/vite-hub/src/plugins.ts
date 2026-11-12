import { defaultDatabaseD1Binding, withComments, withConnectionsDatabase, withDataDir } from "./storage-config.ts"
import { applyCacheStorage, resolveCacheStorage, type CacheOptions } from "./cache.ts"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import frameworkPackageManifest from "../package.json" with { type: "json" }

import { defaultServerConditions } from "vite"

import type { HubCommentsOptions } from "@vite-hub/comments/vite"
import { hubEnv } from "@vite-hub/env/vite"
import { hubBundle } from "@vite-hub/bundle/vite"
import { hubSource } from "@vite-hub/source/vite"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { collapseWranglerConfigFile } from "@vite-hub/internal/build/cloudflare"
import { describeDeploymentPlanOutput, finalizeDeploymentPlanOutput } from "@vite-hub/internal/build/deployment-plan-output"
import { denoServerPackagesPlugin, finalizeDenoDeploymentOutput, type DenoServerPackages } from "@vite-hub/internal/build/deno-runtime-packages"
import { nitroCacheBypass } from "@vite-hub/internal/build/nitro-cache-bypass"
import { createNoExternalAddition, getDeploymentPreset, isServerEnvironment, loadsViteHubPackagesNatively, resolveViteHubProjectRoot, setResolvedFeatureOptions, VITEHUB_DEPLOYMENT_PRESET, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS, workerdDependencyConfig, type ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import { deploymentPresetFromNitro, detectPreset, normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"

import { viteHubTypesPlugin } from "./internal/types.ts"
import { assertFeatureSupported, assertHostService } from "./internal/feature-support.ts"
import type { HostSelectedService } from "./internal/feature-support.ts"
import { assertFeaturePackages, forgetPackageChecks, isPackageInstalled, isPackageInstalledInApp, optionalFeaturePackages, requireOptionalOwner } from "./internal/optional-owners.ts"
import { commentsOffPlugin, optionalOwnerEntriesPlugin, optionalOwnerImportsPlugin, ownerFacadeFeature, ownerModules } from "./internal/owner-modules.ts"
import { withCmsPresetPlugins } from "./internal/cms-preset-features.ts"
import { disabledRedisDriver, disabledUpstashDriver, hasRedisStore, hasUpstashStore, redisDriverSpecifier, upstashDriverSpecifier } from "./internal/kv-runtime.ts"
import { generatedModules } from "./internal/generated-modules.ts"
import { agentChannelEnvPlugin } from "./agent-channel-env.ts"
import { agentInvocationsVitePlugin } from "./agent-invocations-vite.ts"
import { devDefinesVitePlugin } from "./dev-defines-vite.ts"
import { errorLogVitePlugin } from "./error-log-vite.ts"
import { standardContextVitePlugin } from "./standard-context-vite.ts"
import { databaseDisabledPlugin } from "./database-disabled.ts"
import { cloudflarePkceChallengePlugin } from "./cloudflare-pkce-challenge.ts"
import { cloudflareShSyntaxPlugin } from "./cloudflare-sh-syntax.ts"
import { unavailableServicesPlugin } from "./unavailable-services.ts"
import { operationsCheckPlugin } from "./operations-check.ts"
import { setupDevPlugin } from "./setup-dev.ts"
import { consoleInvocationRootPlugin, consoleVitePlugin, resolveConsoleOptions, type ConsoleOptions } from "./console/vite.ts"
import { cloudflareExportConditions } from "./deployment.ts"
import { resolveSystemdUnit, systemdUnitName, writeSystemdUnit, type SystemdOptions } from "./systemd.ts"
import { cloudflareCustomDomainConfig, readProjectWranglerConfig } from "./cloudflare-custom-domain.ts"
import { nitroOrderPlugins } from "./nitro-order.ts"
import { viteHubTaskPlugin } from "./task/vite.ts"
import { viteHubDurabilityPlugin } from "./durability/vite.ts"
import { logsVitePlugin } from "./logs-vite.ts"
import { observabilityVitePlugin, type ObservabilityOptions } from "./observability-vite.ts"
import { isConsoleMcpClientEnabled, resolveConsoleSectionIds } from "./console/runtime/sections.ts"

import type { AgentOptions as AgentPluginOptions } from "@vite-hub/agent"
import type { AgentInvocationsDefault } from "@vite-hub/agent"
import type { AuthOptions } from "@vite-hub/auth"
import type { BlobOptions } from "@vite-hub/blob"
import type { BrowserOptions } from "@vite-hub/browser/vite"
import type { ChannelsOptions } from "@vite-hub/channels/vite"
import type { ConnectionsVitePluginOptions } from "@vite-hub/connections/vite"
import type { DatabaseOptions } from "@vite-hub/database"
import type { EmailOptions } from "@vite-hub/email/vite"
import type { EnvOptions, EnvRuntimeRegistry } from "@vite-hub/env"
import type { EnvVitePlugin } from "@vite-hub/env/vite"
import type { KVOptions } from "@vite-hub/kv"
import type { KVVitePluginAPI } from "@vite-hub/kv/vite"
import type { McpOptions } from "@vite-hub/mcp"
import { resolveViteHubBundleDefines, type ViteAlias } from "@vite-hub/internal/build/bundle-options"
import { cloneRecord } from "@vite-hub/internal/object"
import type { DeploymentPlan, DeploymentService } from "@vite-hub/internal/deployment"
import type { RateLimitOptions } from "@vite-hub/rate-limit"
import type { RealtimeOptions } from "@vite-hub/realtime"
import type { SandboxTaskOptions } from "@vite-hub/sandbox/task/vite"
import type { ScheduleOptions } from "@vite-hub/schedule/vite"
import type { WorkflowOptions } from "@vite-hub/workflow"
import type { WorkspaceOptions } from "@vite-hub/workspace"
import type { I18nOptions } from "@vite-hub/i18n"
import type { PublicUrlConfig } from "@vite-hub/runtime"
import type { QueueOptions } from "@vite-hub/queue"
import type { Plugin, PluginOption, ResolvedConfig, UserConfig } from "vite"
import type { DoctorPluginApi } from "vite-doctor/extension"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

export type { CacheOptions } from "./cache.ts"
export type { ConsoleOptions } from "./console/vite.ts"
export type { ObservabilityEvlogOptions, ObservabilityLogsOptions, ObservabilityOptions } from "./observability-vite.ts"
export type { SystemdOptions } from "./systemd.ts"
export type { AgentInvocationsDefault, AgentInvocationsDefaultJournal } from "@vite-hub/agent"
export type { AuthOptions } from "@vite-hub/auth"
export type { BlobOptions } from "@vite-hub/blob"
export type { BrowserOptions } from "@vite-hub/browser/vite"
export type { ChannelsOptions } from "@vite-hub/channels/vite"
export type { DatabaseOptions } from "@vite-hub/database"
export type { EmailOptions } from "@vite-hub/email/vite"
export type { EnvOptions } from "@vite-hub/env"
export type { KVOptions } from "@vite-hub/kv"
export type { I18nOptions } from "@vite-hub/i18n"
export type { QueueOptions } from "@vite-hub/queue"
export type { RateLimitOptions } from "@vite-hub/rate-limit"
export type { RealtimeOptions } from "@vite-hub/realtime"
export type { SandboxTaskOptions } from "@vite-hub/sandbox/task/vite"
export type { ScheduleOptions } from "@vite-hub/schedule/vite"
export type { WorkflowOptions } from "@vite-hub/workflow"
export type { WorkspaceOptions } from "@vite-hub/workspace"

type FrameworkDependencyName = Extract<keyof typeof frameworkPackageManifest.dependencies | keyof typeof frameworkPackageManifest.peerDependencies, `@vite-hub/${string}`>
type DeploymentServicesManifest = Record<DeploymentService, object>

function resolveServerOptions(config: ResolvedConfig) {
  // SAFETY: Resolved environment configs use Vite's complete resolved resolve-options shape, matching the root fallback.
  const serverResolve = (config.environments?.nitro?.resolve
    ?? config.environments?.ssr?.resolve
    ?? config.resolve) as typeof config.resolve | undefined
  const conditions = serverResolve?.conditions ?? defaultServerConditions
  return {
    alias: serverResolve?.alias,
    conditions: conditions.map(condition => condition === "development|production" ? (config.isProduction ? "production" : "development") : condition),
    extensions: serverResolve?.extensions ?? [],
    mainFields: serverResolve?.mainFields ?? [],
    preserveSymlinks: serverResolve?.preserveSymlinks ?? false,
  }
}

const generatedOwnerPackageAccess = {
  "@vite-hub/agent": true,
  "@vite-hub/auth": true,
  "@vite-hub/blob": true,
  "@vite-hub/bundle": false,
  "@vite-hub/browser": true,
  "@vite-hub/sandbox": true,
  "@vite-hub/channels": true,
  "@vite-hub/cli": false,
  "@vite-hub/cms": true,
  "@vite-hub/comments": true,
  "@vite-hub/connections": true,
  "@vite-hub/content": true,
  "@vite-hub/database": true,
  "@vite-hub/decisions": true,
  "@vite-hub/docs": true,
  "@vite-hub/email": true,
  "@vite-hub/env": true,
  "@vite-hub/forge": true,
  "@vite-hub/forms": true,
  "@vite-hub/gateways": true,
  "@vite-hub/i18n": true,
  "@vite-hub/kv": true,
  "@vite-hub/markdown-template": true,
  "@vite-hub/mcp": true,
  "@vite-hub/presets": true,
  "@vite-hub/queue": true,
  "@vite-hub/rate-limit": true,
  "@vite-hub/realtime": true,
  "@vite-hub/runtime": true,
  "@vite-hub/schedule": true,
  "@vite-hub/shell": true,
  "@vite-hub/source": true,
  "@vite-hub/ui": true,
  // Browser-only: generated server code never imports it.
  "@vite-hub/web-container": false,
  "@vite-hub/workflow": true,
  "@vite-hub/workspace": true,
} satisfies Record<FrameworkDependencyName, boolean>

const generatedOwnerPackageNames = Object.entries(generatedOwnerPackageAccess)
  .filter(([, allowed]) => allowed)
  .map(([name]) => name)

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

let generatedOwnerProviderImportAliases: Record<string, string> | undefined

function getGeneratedOwnerProviderImportAliases(): Record<string, string> {
  return generatedOwnerProviderImportAliases ??= Object.fromEntries(generatedOwnerPackageNames.flatMap((packageName) => {
    if (!isPackageInstalled(packageName)) return []
    const manifestPath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`))
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (!isRecord(manifest) || !("exports" in manifest)) return []
    const packageExports = manifest.exports
    if (!isRecord(packageExports)) return []
    return Object.keys(packageExports).flatMap((subpath) => {
      if (subpath !== "." && !subpath.startsWith("./")) return []
      const specifier = subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`
      try {
        return [[specifier, fileURLToPath(import.meta.resolve(specifier))] as const]
      }
      catch {
        return []
      }
    })
  }))
}

const frameworkVirtualImporters = new Set([
  "\0#vitehub/auth/server",
  "\0#vitehub/env/server",
  "\0#vitehub/env/description",
  "\0#vitehub/schedule/registry",
  "\0virtual:vitehub-agent-cloudflare-state-exports",
])

const frameworkPackageName = "vite-hub"
function packageExportImportTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined

  const importTarget = Reflect.get(target, "import")
  return typeof importTarget === "string" ? importTarget : undefined
}

interface FrameworkWorkspaceDependencyRuntimeImports {
  sandboxTask?: string
  sandboxTaskRuntimeState?: string
  shellWorkspace?: string
}

function frameworkWorkspaceDependencyRuntimeImports(sandboxTaskRuntimeState: string | undefined): FrameworkWorkspaceDependencyRuntimeImports {
  return {
    ...(sandboxTaskRuntimeState
      ? {
          sandboxTask: "vite-hub/sandbox/task",
          sandboxTaskRuntimeState,
        }
      : {}),
    ...(isPackageInstalled("@vite-hub/shell") ? { shellWorkspace: "vite-hub/shell/workspace" } : {}),
  }
}

/**
 * Workspace shell commands need `@vite-hub/shell`, an optional peer that the app installs. Its loader pulls just-bash
 * (about 2 MB) into every Agent server, so keep it only when the app resolves the package from its own root. The Agent,
 * Workflow, and Sandbox Task plugins read `imports` when they generate code. Code generated before this hook keeps
 * the loader, as before.
 */
function workspaceShellPlugin(imports: FrameworkWorkspaceDependencyRuntimeImports): Plugin {
  return {
    name: "vite-hub/workspace-shell",
    enforce: "pre",
    config: {
      order: "pre",
      handler(config) {
        // SAFETY: ViteHub hosts add this private project-root key before plugins read the config.
        const projectRoot = (config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string })[VITEHUB_PROJECT_ROOT]
        const root = projectRoot ? resolve(projectRoot) : resolveViteHubProjectRoot(config.root ?? process.cwd())
        if (!isPackageInstalledInApp(root, "@vite-hub/shell")) delete imports.shellWorkspace
      },
    },
  }
}

// One resolve for the package root. A resolve per export (about 240) took 130 ms of every `vite` start.
const frameworkPackageRoot = new URL(".", import.meta.resolve(`${frameworkPackageName}/package.json`))
const envServerRuntimeImport = fileURLToPath(import.meta.resolve("@vite-hub/env/internal/server"))

/** A pattern that matches `specifier` and nothing under it. */
function exactSpecifier(specifier: string): RegExp {
  return new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
}

function frameworkExportAliases(include: (importTarget: string) => boolean): [string, string][] {
  return Object.entries(frameworkPackageManifest.exports).flatMap(([subpath, target]): [string, string][] => {
    const importTarget = packageExportImportTarget(target)
    if (!subpath.startsWith("./") || importTarget === undefined || !include(importTarget)) return []
    return [[`${frameworkPackageName}/${subpath.slice(2)}`, fileURLToPath(new URL(importTarget, frameworkPackageRoot))]]
  })
}

const frameworkProviderImportAliases = Object.fromEntries(
  frameworkExportAliases(importTarget => importTarget.endsWith(".js"))
    .sort(([left], [right]) => right.length - left.length),
)
// Exports that are not JavaScript, such as `vite-hub/ui/styles.css`.
const frameworkAssetImportAliases = Object.fromEntries(frameworkExportAliases(importTarget => !importTarget.endsWith(".js")))

function escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")
}

// The dependency resolver answers bare specifiers, such as `vite-hub/kv`, `#vitehub/env/server` and `nitro/app`, and the
// `vite-hub` files that framework aliases point to. It never answers a relative import or a virtual module.
const frameworkDependencyIds = [/^[^./\0]/, new RegExp(`^${escapeRegExp(fileURLToPath(frameworkPackageRoot))}`)]
const blobImports = new RegExp(`^(?:${["vite-hub/blob", frameworkProviderImportAliases["vite-hub/blob"]].filter(id => id !== undefined).map(escapeRegExp).join("|")})$`)

// Generated server modules import Nitro and H3 by name. An app that lists only vite-hub cannot resolve them from its
// root without hoisting, so these imports fall back to the Nitro that vite-hub installs, and to that Nitro's H3.
const nitroImport = /^nitro(?:\/|$)/
const h3Import = /^h3(?:\/|$)/
let nitroFallbackImporters: { h3: string, nitro: string } | undefined

function getNitroFallbackImporter(id: string): string | undefined {
  if (!nitroImport.test(id) && !h3Import.test(id)) return
  nitroFallbackImporters ??= {
    h3: fileURLToPath(import.meta.resolve("nitro/package.json")),
    nitro: fileURLToPath(import.meta.resolve("vite-hub/package.json")),
  }
  return nitroImport.test(id) ? nitroFallbackImporters.nitro : nitroFallbackImporters.h3
}

function isGeneratedImporter(importer: string | undefined) {
  const normalized = importer?.replace(/\\/g, "/")
  return Boolean(normalized && (/(?:^|\/)\.vitehub(?:\/|$)/.test(normalized) || frameworkVirtualImporters.has(normalized)))
}

/** Stubs the provider drivers that no KV store can use, so a build does not bundle their SDKs. */
function configureProviderOptionalImportAliases(
  aliases: Record<string, string>,
  options: ViteHubOptions,
  configuredKV: KVOptions | undefined,
  hosting: string | undefined,
) {
  const effectiveKV = configuredKV ?? options.kv
  const kv = effectiveKV
    ? requireOptionalOwner(ownerModules.kvVite, "kv").resolveKVViteConfig(effectiveKV === true ? undefined : effectiveKV, { hosting }).kv
    : false
  if (hasUpstashStore(kv)) delete aliases[upstashDriverSpecifier]
  else aliases[upstashDriverSpecifier] = disabledUpstashDriver
  if (hasRedisStore(kv)) delete aliases[redisDriverSpecifier]
  else aliases[redisDriverSpecifier] = disabledRedisDriver
}

function frameworkDependencyResolver(
  options: ViteHubOptions,
  envPlugin: EnvVitePlugin | undefined,
  providerImportAliases: Record<string, string>,
  blobEnabled: boolean,
  configuredKV: KVOptions | undefined,
  kvHosting: string | undefined,
): Plugin & ViteHubProviderImportContributor {
  return {
    name: "vite-hub/dependencies",
    vitehub: {
      providerOutput: {
        getImportAliases: getGeneratedOwnerProviderImportAliases,
      },
    },
    enforce: "pre",
    config() {
      const aliases: Record<string, string> = { ...frameworkProviderImportAliases, ...frameworkAssetImportAliases }
      if (!blobEnabled) delete aliases["vite-hub/blob"]
      // A Vite alias resolves before any plugin. Without one, the import of a facade whose package the app did not
      // install reaches the optional owner imports plugin, which names the package to install.
      for (const specifier of Object.keys(aliases)) {
        const feature = ownerFacadeFeature(specifier)
        if (feature && !optionalFeaturePackages[feature].every(isPackageInstalled)) delete aliases[specifier]
      }
      // Each alias matches its specifier alone. A Vite alias given as a string also matches the subpaths under it, so
      // a subpath the package doesn't export, such as `vite-hub/realtime/nope`, would load `dist/realtime.js/nope`
      // instead of failing as not exported.
      return {
        resolve: {
          alias: Object.entries(aliases).map(([specifier, replacement]) => ({ find: exactSpecifier(specifier), replacement })),
        },
      }
    },
    // Vite closes the plugins when the dev server stops and when a build ends. Nuxt closes its Vite server before it
    // reloads the app. The next start must see the packages that the app installed or removed in the meantime.
    closeBundle() {
      forgetPackageChecks()
    },
    configResolved(config) {
      if (envPlugin && config.root) {
        const envProjectRoot = envPlugin.api.resolveProjectRoot(config.root)
        providerImportAliases["#vitehub/env/server"] = resolve(envProjectRoot, ".vitehub/env/server.mjs")
        providerImportAliases["#vitehub/env/description"] = resolve(envProjectRoot, ".vitehub/env/description.mjs")
      }
      configureProviderOptionalImportAliases(
        providerImportAliases,
        options,
        configuredKV,
        kvHosting,
      )
    },
    resolveId: {
      filter: { id: frameworkDependencyIds },
      handler(id, importer, resolveOptions) {
        if (!blobEnabled && id === "@vite-hub/blob") {
          throw viteHubErrorDiagnostics.VITE_HUB_R0075({ message: "[vitehub] Blob is unavailable for this deployment preset. Configure an explicit Blob store before using Blob APIs or Agent Capabilities." })
        }
        for (const specifier in providerImportAliases) {
          const frameworkFacade = frameworkProviderImportAliases[specifier]
          if (!frameworkFacade) continue
          const providerFacade = providerImportAliases[specifier]
          if (id === frameworkFacade || providerImportAliases[id] === providerFacade) return providerFacade
        }
        if (!isGeneratedImporter(importer)) return
        const nitroFallbackImporter = getNitroFallbackImporter(id)
        if (nitroFallbackImporter) {
          // Only this branch is asynchronous, so the other imports keep resolving, and throwing, synchronously.
          const options = { ...resolveOptions, skipSelf: true }
          return this.resolve(id, importer, options).then(resolved => resolved ?? this.resolve(id, nitroFallbackImporter, options))
        }
        const isFrameworkPackageImport = id === frameworkPackageName || id.startsWith(`${frameworkPackageName}/`)
        const isOwnerPackageImport = generatedOwnerPackageNames.some(name => id === name || id.startsWith(`${name}/`))
        if (!isFrameworkPackageImport && !isOwnerPackageImport) return
        return fileURLToPath(import.meta.resolve(id))
      },
    },
  }
}

/** Agent options of `vitehub()`. */
export interface AgentOptions extends AgentPluginOptions {
  /**
   * Invocation journal for Agent Definitions from `vite-hub/agent` that do not set `invocations`. The Console reads it.
   * Omit it, or pass `{ databaseUrl, observations, retention }`, for the default journal: local SQLite at
   * `.vitehub/data/agent-invocations.sqlite`, or the D1 binding of the default Database in a Cloudflare production build.
   * `"database"` uses the app's ViteHub Database. `"memory"` keeps records in the server process. `false` records no journal.
   * Requires Nitro-hosted Agents. Netlify and `runtime: "deno"` require `false` and journals on each Agent Definition.
   */
  invocations?: AgentInvocationsDefault
}

/** Cloudflare options of `vitehub()`. */
export interface CloudflareOptions {
  /**
   * A `.env` or JSON file, relative to the project root, whose values `nitro deploy --prebuilt` uploads as Worker secrets.
   * ViteHub adds `--secrets-file` to the generated deploy command only when the file exists at build time.
   * It never reads the file.
   */
  secretsFile?: string
}

/** `connections` options of `vitehub()`. */
export type ConnectionsOptions = Omit<ConnectionsVitePluginOptions, "database" | "databaseName" | "importBase"> & {
  /** The Database that stores grants, approvals, and activity, such as `"users"`. Defaults to `default`. */
  database?: string
}

export interface ViteHubNodeOptions {
  /**
   * The number of server instances that run this build. The server fails at boot when it is greater than 1 and a
   * primitive keeps its state in one process or on one host, such as the `fs-lite` KV store or the memory Rate Limit.
   * `VITEHUB_INSTANCES` overrides it when the server starts. Default: 1.
   */
  instances?: number
}

export interface ViteHubOptions {
  /** Local storage defaults for a Node host with a persistent filesystem. Relative to the working directory. */
  dataDir?: string
  /**
   * The host to build for. When omitted, `detectHost()` from `vite-hub/runtime` reads it from `VITEHUB_HOSTING`,
   * `NITRO_PRESET`, `SERVER_PRESET`, or the provider variables of Cloudflare Workers Builds, Netlify, Vercel, and Deno Deploy.
   * Without any of them, ViteHub builds for `"node"`.
   */
  preset?: DeploymentPreset
  name?: string
  /**
   * Public origin of the deployed application, such as `https://agents.example.com`.
   * Console links, GitHub activity links, telemetry session links, the Auth base URL, and Connections OAuth callbacks use it.
   * A function receives each discovered Agent name. Builds only; `vite dev` uses the request origin.
   * Server code reads it with `resolvePublicUrl()` from `vite-hub/runtime`. A string is also the default `--url` of
   * `vitehub channels sync` and `channels history`, and on the `cloudflare` preset it adds the custom-domain route
   * unless the app configures Worker routing.
   */
  publicUrl?: string | ((agentName: string) => string)
  agent?: boolean | AgentOptions
  auth?: boolean | AuthOptions
  blob?: boolean | BlobOptions
  browser?: boolean | BrowserOptions
  /**
   * Storage for Nitro's `cache` mount, which `defineCachedFunction()` and `defineCachedEventHandler()` use.
   * `true` selects the preset's store: Workers KV binding `CACHE`, Vercel Runtime Cache, Deno KV, or `.vitehub/data/cache` on Node.
   * Development uses `.vitehub/data/cache`.
   * `{ driver: "kv" }` stores the cache in the app's default KV store under the `nitro-cache:` prefix, in development too. It requires `kv`.
   */
  cache?: boolean | CacheOptions
  channels?: boolean | ChannelsOptions
  /** Options for the `cloudflare` preset. Other presets ignore them. */
  cloudflare?: CloudflareOptions
  /** Options for the `node` preset. Other presets ignore them. */
  node?: ViteHubNodeOptions
  /**
   * App-owned OAuth and API key Connections in `server/connections/`. They store grants in the `default` Database, or
   * in the Database that `database` names, and enable `database` when it is unset.
   */
  connections?: boolean | ConnectionsOptions
  /**
   * The Console endpoint, `POST /_vitehub/rpc`, which the ViteHub Console at console.vitehub.dev and the CLI call with
   * signed requests. Off by default, but `vite dev` still serves the operation RPC for the CLI. `false` turns that RPC off too.
   * `true` takes calls signed with a key in `VITEHUB_CONSOLE_KEY_<NAME>`.
   * `{ auth: false }` takes calls without a signature, for development only.
   */
  console?: boolean | ConsoleOptions
  /** Drizzle Databases in `server/databases/`. Without a Database Definition, an enabled database is one empty default Database. */
  /**
   * Writes a bundle report of each production build to `.vitehub/bundle/`: client and server size, the code that loads
   * at startup, and why each package is there. Read it with `vitehub bundle`. Off by default.
   */
  bundle?: boolean
  database?: boolean | DatabaseOptions
  email?: boolean | EmailOptions
  /**
   * Public Env, Server Env, and build-time replacements in `public`, `server`, and `define`, with the options that resolve
   * them. On by default. `false` turns Env off.
   */
  env?: false | EnvOptions
  kv?: boolean | KVOptions
  /**
   * The app MCP server at `/mcp`, with one tool per file in `server/mcp/tools/`. With `auth`, MCP clients sign in with
   * `mcpOAuth()` from `vite-hub/auth/mcp`. Needs `@vite-hub/mcp`.
   */
  mcp?: boolean | McpOptions
  /**
   * Request logs through Evlog, the logs that the Console and `vitehub logs` read with `logs`, and, with `service`, Agent
   * telemetry and papercut reports through `useObservability()`.
   */
  observability?: boolean | ObservabilityOptions
  /** Queue Definitions in `server/queues/`. `true` uses the host's provider. An object sets Queue options, such as `cache`. */
  queue?: boolean | QueueOptions
  /**
   * Messages in the source language, translated per request: `{ i18n: { locales: ["en", "es"] } }`. The first locale is
   * the language of the code. Write ``t`Save` `` in templates, and import `t` from `vite-hub/i18n` in scripts and server
   * code. Translations are records in `locales/<locale>/`, and `vitehub i18n status` shows what is missing. Needs
   * Nitro 3: Nuxt 5, or Vite with Nitro 3.
   */
  i18n?: I18nOptions
  /**
   * Comments on the app's pages. `true`, or an object with the Database, the SQL dialect, or `overlay: false` (no page
   * tool), turns it on, with `server/comments.ts` or else the default `defineComments()`, and turns the Database on
   * when `database` is unset. Default: on when the app has `server/comments.ts`. The Console does not turn it on.
   * `false` turns it off.
   */
  comments?: boolean | Pick<HubCommentsOptions, "database" | "dialect" | "overlay">
  rateLimit?: boolean | RateLimitOptions
  realtime?: boolean | RealtimeOptions
  /**
   * A systemd unit for the server, written to `.output/<name>.service` by production builds on the `node` preset. On by
   * default. It starts `node .output/server/index.mjs` in the project root, reads `.env` when it exists, and waits for the
   * Agent drain budget plus 30 seconds on stop. An object sets the name, user, directory, and environment. `false` writes
   * no unit. Other presets ignore it.
   */
  systemd?: boolean | SystemdOptions
  /** Sandbox Tasks in `server/sandbox-tasks/` and `*.sandbox-task.ts` files. Each run starts an isolated Cloudflare or Vercel Sandbox. */
  sandboxTask?: boolean
  schedule?: boolean | ScheduleOptions
  workflow?: boolean | WorkflowOptions
  workspace?: boolean | WorkspaceOptions
}

export type DeploymentPreset = "cloudflare" | "deno" | "netlify" | "node" | "vercel"

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
    throw viteHubErrorDiagnostics.VITE_HUB_R0076({ message: "[vitehub] vitehub name must contain at least one letter or number." })
  }
  const workersBuilds = normalizeDeploymentName(workersBuildsName)
  if (workersBuildsName?.trim() && !workersBuilds) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0077({ message: "[vitehub] WRANGLER_CI_OVERRIDE_NAME must contain at least one letter or number." })
  }
  if (configured && workersBuilds && configured !== workersBuilds) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0078({ message: `[vitehub] deployment identity ${JSON.stringify(configured)} conflicts with WRANGLER_CI_OVERRIDE_NAME=${JSON.stringify(workersBuildsName)}.` })
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

function requiredCloudflareSecretNames(registry: EnvRuntimeRegistry): string[] {
  const names = new Set<string>()
  const visit = (value: unknown): void => {
    const entry = cloneRecord(value)
    const source = cloneRecord(entry.source)
    if (source.kind === "env" && typeof source.name === "string") {
      // Wrangler cannot express alternatives, including canonical and conventional names.
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

/** A path relative to the output directory, starting with `./` outside shell quotes so Nitro's deploy --prebuilt rewrite can rebase it. */
function outputRelativeArgument(outputDir: string, file: string): string {
  const path = relative(outputDir, file).replaceAll("\\", "/")
  return /^[\w./-]+$/.test(path) ? `./${path}` : `./${shellQuote(path)}`
}

type ResolvedBuildConfig = {
  alias: ViteAlias[]
  conditions: string[]
  define: Record<string, string>
  extensions: string[]
  hasScheduleIntegration: boolean
  mainFields: string[]
  preserveSymlinks: boolean
}

interface BundlerConfig { plugins?: unknown }

function deploymentNitroModule(
  plan: DeploymentPlan,
  services: DeploymentServicesManifest,
  identity: DeploymentIdentity,
  sandboxTaskRequested: boolean,
  secretsFilePath: string | undefined,
  isDeployCommandOwned: () => boolean,
  resolvedBuildConfig: () => ResolvedBuildConfig,
  systemd: { drainMs: number, name: string, options: SystemdOptions } | undefined,
) {
  return (nitro: {
    hooks: {
      hook: ((name: "compiled", callback: () => Promise<void>) => void)
        & ((name: "build:config", callback: (nitro: unknown, config: { rolldown?: BundlerConfig, rollup?: BundlerConfig }) => void) => void)
    }
    options: { cloudflare?: { deployConfig?: boolean }, commands: Record<string, unknown>, output: { dir: string, serverDir: string }, preset?: string, rootDir: string }
  }) => {
    if (deploymentPresetFromNitro(nitro.options.preset) !== plan.preset) return
    if (plan.preset === "cloudflare" && nitro.options.cloudflare?.deployConfig !== false && !isDeployCommandOwned()) {
      // Nitro's `--cwd ./` relies on the `.wrangler/deploy` redirect in the project root, which a copied output lacks and a parent Wrangler config breaks.
      // `--cwd` into the server directory fails once that redirect exists, so name the config file.
      const config = outputRelativeArgument(nitro.options.output.dir, join(nitro.options.output.serverDir, "wrangler.json"))
      // A Workers Builds or Deploy button build has no local secrets file, so its command must not name one.
      const secretsFile = secretsFilePath && resolve(nitro.options.rootDir, secretsFilePath)
      const secrets = secretsFile && existsSync(secretsFile) ? ` --secrets-file ${outputRelativeArgument(nitro.options.output.dir, secretsFile)}` : ""
      nitro.options.commands.deploy = `npx wrangler deploy --config ${config}${secrets}${sandboxTaskRequested ? " --containers-rollout=gradual" : ""}`
    }
    let serverPackages: DenoServerPackages | undefined
    if (plan.output.packaging === "deno-node-modules") {
      const addPackagesPlugin = (bundler: BundlerConfig | undefined) => {
        if (!bundler) return
        const plugins = Array.isArray(bundler.plugins) ? bundler.plugins : bundler.plugins ? [bundler.plugins] : []
        bundler.plugins = [...plugins, denoServerPackagesPlugin((packages) => { serverPackages = packages })]
      }
      // Nitro passes the configuration for its resolved builder.
      nitro.hooks.hook("build:config", (_nitro, config) => addPackagesPlugin(config.rolldown ?? config.rollup))
    }
    nitro.hooks.hook("compiled", async () => {
      const outputDir = nitro.options.output.dir
      const rootDir = nitro.options.rootDir
      // Nitro concatenates the project's Wrangler arrays with the generated ones, so a binding both declare appears twice.
      if (plan.preset === "cloudflare") await collapseWranglerConfigFile(nitro.options.output.serverDir)
      if (plan.output.packaging === "deno-node-modules") {
        if (!serverPackages) throw viteHubErrorDiagnostics.VITE_HUB_B0017({ message: "[vitehub] The Deno server bundle did not report its runtime packages." })
        await finalizeDenoDeploymentOutput({ deploymentName: identity.name, outputDir, rootDir, serverPackages, ...resolvedBuildConfig() })
      }
      await finalizeDeploymentPlanOutput({ identity, outputDir, plan, rootDir, services })
      if (systemd) {
        const unit = resolveSystemdUnit({
          drainMs: systemd.drainMs,
          name: systemd.name,
          outputEntry: join(nitro.options.output.serverDir, "index.mjs"),
          rootDir,
          systemd: systemd.options,
        })
        await writeSystemdUnit(outputDir, systemd.name, unit)
      }
    })
  }
}

function afterApplicationConfig<T extends Plugin>(plugin: T): T {
  // Deployment defaults use the root returned by ordinary application config hooks.
  // Keep the owned primitives after those defaults and before Nitro reads their output.
  const hook = plugin.config
  if (hook) plugin.config = typeof hook === "function"
    ? { handler: hook, order: "post" }
    : { ...hook, order: "post" }
  return plugin
}

/** The `agent.shutdown.drainMs` default of the shutdown budget, which the generated server applies. */
function agentDrainMs(agent: ViteHubOptions["agent"]): number {
  const drainMs = agent && agent !== true && agent.shutdown ? agent.shutdown.drainMs : undefined
  return typeof drainMs === "number" && Number.isFinite(drainMs) && drainMs >= 0 ? drainMs : 0
}

/** A Node server has no host cron. Its Schedules run only in the Process Runtime or when the app wakes them itself. */
function assertNodeScheduleWake(schedule: ViteHubOptions["schedule"]): void {
  if (!schedule) return
  if (schedule !== true) {
    if (schedule.providerOutput === false) return
    if (schedule.runtime !== undefined && schedule.providerOutput !== "nitro" && schedule.providerOutput !== "standalone") return
  }
  throw viteHubErrorDiagnostics.VITE_HUB_R0137({ message: "[vitehub] The \"node\" preset has no host cron, so this build would never run its Schedules. Set schedule: { runtime: { driver: \"process\" }, providerOutput: \"auto\" } to run them in the server process, or schedule: { providerOutput: false } to wake them yourself." })
}

function deploymentPlugins(
  plan: DeploymentPlan,
  requestedServices: HostSelectedService[],
  blobEnabled: boolean,
  services: DeploymentServicesManifest,
  options: ViteHubOptions,
  envPlugin: EnvVitePlugin | undefined,
): Plugin[] {
  const observabilityLogs = options.observability && options.observability !== true && options.observability.logs
  let deployCommandOwned = false
  const resolvedBuildConfigs = new WeakMap<object, { current: ResolvedBuildConfig }>()
  let providerOutput: ReturnType<typeof useProviderOutputCatalog> | undefined
  let deploymentRoot: string | undefined
  let deploymentOutputDir: string | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  const deploymentEnvPlugin = { current: envPlugin }
  const subscribedEnvPlugins = new WeakSet<EnvVitePlugin>()
  const subscribeEnvPlugin = (plugin: EnvVitePlugin): void => {
    deploymentEnvPlugin.current = plugin
    if (subscribedEnvPlugins.has(plugin) || plan.preset !== "cloudflare") return
    subscribedEnvPlugins.add(plugin)
    plugin.api.onServerEnvRegistry((registry: EnvRuntimeRegistry, config: UserConfig) => {
      if (getDeploymentPreset(config) !== plan.preset) return
      const providerOutput = useProviderOutputCatalog(config)
      contributeCloudflareProviderOutput(providerOutput, {
        owner: "env",
        requiredSecrets: requiredCloudflareSecretNames(registry),
      })
      const viteConfig = config as typeof config & { nitro?: unknown }
      viteConfig.nitro = composeNitroCloudflareProviderOutput(providerOutput, viteConfig.nitro)
    })
  }
  if (envPlugin) subscribeEnvPlugin(envPlugin)
  const nitroPreset = plan.preset === "deno" ? "deno-server" : plan.nitroPreset
  return [
    {
      name: "vite-hub/deployment-settings",
      enforce: "pre",
      configEnvironment: { order: "post", handler: workerdDependencyConfig },
      config: {
        order: "pre",
        handler(config, environment) {
          Reflect.set(config, VITEHUB_DEPLOYMENT_PRESET, plan.preset)
          // Owners such as KV need the host before their early config hooks run.
          // Resource names wait until ordinary plugins have configured the root.
          const nitro = cloneRecord((config as { nitro?: unknown }).nitro)
          if (environment.command === "build" && nitro.preset === undefined) nitro.preset = nitroPreset
          if (environment.command === "build" && plan.preset === "cloudflare") nitro.exportConditions = cloudflareExportConditions(nitro.exportConditions)
          ;(config as { nitro?: unknown }).nitro = nitro
        },
      },
    },
    {
      name: "vite-hub/deployment-preset",
      enforce: "pre",
      nitro: {
        async setup(nitro) {
          // Keep Nitro's single config load (including dotenv) authoritative.
          const configured = nitro.options._c12.layers?.some(layer =>
            layer.config?.serverDir !== undefined || layer.config?.srcDir !== undefined)
          if (configured) return
          const serverDir = resolve(nitro.options.rootDir, "server") + "/"
          nitro.options.serverDir = serverDir
          if (!nitro.options.scanDirs.includes(serverDir)) nitro.options.scanDirs.unshift(serverDir)
          // Nitro has already scanned plugins, tasks and modules at this point.
          // Reuse the pinned Nitro version's scanners to preserve its ignore rules,
          // task precedence and module loading/deduplication semantics.
          const builderUrl = import.meta.resolve("nitro/builder")
          const { scanAndSyncOptions } = await import(new URL("./_chunks/nitro2.mjs", builderUrl).href)
          const { installModules } = await import(new URL("./_chunks/nitro.mjs", builderUrl).href)
          const existingModules = new Set(nitro.options.modules)
          await scanAndSyncOptions(nitro)
          await installModules(nitro, (nitro.options.modules ?? []).filter(module => !existingModules.has(module)))
        },
      },
      resolveId: {
        filter: { id: blobImports },
        handler(source) {
          if (!blobEnabled && (source === "vite-hub/blob" || source === frameworkProviderImportAliases["vite-hub/blob"])) {
            assertHostService(plan, "blob")
            throw viteHubErrorDiagnostics.VITE_HUB_R0079({ message: "[vitehub] Blob is disabled but the application imports " + JSON.stringify(source) + "." })
          }
        },
      },
      config: {
        // Resolve identity after ordinary plugins configure the application root.
        order: "post",
        handler(config, environment) {
          const building = environment.command === "build"
          Reflect.set(config, VITEHUB_DEPLOYMENT_PRESET, plan.preset)
          for (const service of requestedServices) assertHostService(plan, service)
          // The dev server keeps manual runs working without a wake owner.
          if (building && plan.preset === "node") assertNodeScheduleWake(options.schedule)
          const identity = resolveDeploymentIdentity(
            typeof config.root === "string" ? config.root : undefined,
            options.name,
            plan.preset === "cloudflare" ? process.env.WRANGLER_CI_OVERRIDE_NAME : undefined,
          )
          const name = identity.name
          if (requestedServices.includes("queue") && plan.services.queue.supported) {
            const configuredQueue = options.queue && options.queue !== true ? options.queue : undefined
            const provider = configuredQueue?.provider ?? plan.services.queue.adapter
            const namePrefix = configuredQueue && "namePrefix" in configuredQueue ? configuredQueue.namePrefix : undefined
            setResolvedFeatureOptions(config, "queue", {
              ...configuredQueue,
              provider,
              ...(provider === "cloudflare" && namePrefix === undefined ? { namePrefix: `${name}-` } : {}),
            })
          }
          if (requestedServices.includes("rateLimit") && plan.services.rateLimit.supported) {
            setResolvedFeatureOptions(config, "rateLimit", {
              ...cloneRecord(options.rateLimit === true ? undefined : options.rateLimit),
              namespace: name,
              // Cloudflare Rate Limit bindings exist only in the built wrangler.json, so the dev server keeps the owner
              // default for `serve`: one in-memory limiter.
              provider: building ? plan.services.rateLimit.adapter : "memory",
            })
          }
          if (requestedServices.includes("sandbox") && plan.services.sandbox.supported) {
            setResolvedFeatureOptions(config, "sandboxTask", {
              ...(plan.services.sandbox.adapter === "cloudflare"
                ? { name: cloudflareResourceScope(name) + "-sandbox" }
                : {}),
              provider: plan.services.sandbox.adapter,
            })
          }
          let nitro = cloneRecord((config as { nitro?: unknown }).nitro)
          if (blobEnabled && plan.services.blob.supported && plan.services.blob.adapter === "cloudflare-r2") {
            const optionBlob = options.blob === true ? undefined : options.blob
            if (!hasExplicitBlobStore(optionBlob)) {
              setResolvedFeatureOptions(config, "blob", presetBlobOptions(plan, cloneRecord(optionBlob), cloudflareR2BucketName(name)))
            }
          }
          if (plan.preset === "cloudflare") {
            const wasm = cloneRecord(nitro.wasm)
            if (wasm.lazy === undefined) wasm.lazy = true
            nitro.wasm = wasm
            const cloudflare = cloneRecord(nitro.cloudflare)
            const wrangler = cloneRecord(cloudflare.wrangler)
            if (typeof wrangler.name !== "string") wrangler.name = cloudflareResourceScope(name)
            if (observabilityLogs && wrangler.observability === undefined) wrangler.observability = { enabled: true }
            if (building && typeof options.publicUrl === "string") {
              // Nitro reads the project wrangler file from its root, which is the Vite root.
              const project = readProjectWranglerConfig(resolve(config.root ?? process.cwd()))
              Object.assign(wrangler, cloudflareCustomDomainConfig(normalizePublicUrl(options.publicUrl), wrangler, project))
            }
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
            throw viteHubErrorDiagnostics.VITE_HUB_R0080({ message: "[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with VITEHUB_HOSTING=" + JSON.stringify(configuredHosting) + "." })
          }
          if (building) {
            if (configuredPreset && normalizeNitroPreset(configuredPreset) !== nitroPreset) {
              throw viteHubErrorDiagnostics.VITE_HUB_R0081({ message: "[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with nitro.preset " + JSON.stringify(configuredPreset) + "." })
            }
            for (const name of ["NITRO_PRESET", "SERVER_PRESET"] as const) {
              const value = process.env[name]
              if (value && normalizeNitroPreset(value) !== nitroPreset) {
                throw viteHubErrorDiagnostics.VITE_HUB_R0082({ message: "[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with " + name + "=" + JSON.stringify(value) + "." })
              }
            }
            const buildConfigRef: { current: ResolvedBuildConfig } = {
              current: {
                alias: [],
                conditions: [],
                define: {},
                extensions: [],
                hasScheduleIntegration: false,
                mainFields: [],
                preserveSymlinks: false,
              },
            }
            const systemdOptions = options.systemd === true || options.systemd === undefined ? {} : options.systemd || undefined
            const systemd = plan.preset === "node" && systemdOptions
              ? { drainMs: agentDrainMs(options.agent), name: systemdUnitName(systemdOptions, name), options: systemdOptions }
              : undefined
            const module = deploymentNitroModule(plan, services, identity, requestedServices.includes("sandbox"), options.cloudflare?.secretsFile, () => deployCommandOwned, () => buildConfigRef.current, systemd)
            resolvedBuildConfigs.set(module, buildConfigRef)
            nitro.modules = [
              module,
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
              const envPluginApi = deploymentEnvPlugin.current.api
              const providerOutput = useProviderOutputCatalog(config)
              contributeCloudflareProviderOutput(providerOutput, {
                owner: "env",
                requiredSecrets: requiredCloudflareSecretNames(envPluginApi.createServerEnvRegistry(envPluginApi.resolveDeclarations(config)?.server)),
              })
              nitro = composeNitroCloudflareProviderOutput(providerOutput, nitro)
            }
          }
          if (options.cache) {
            const cacheStorage = resolveCacheStorage(options.cache, plan.preset, options.kv ? requireOptionalOwner(ownerModules.kvVite, "kv").kvNitroCacheDriver : undefined)
            nitro = applyCacheStorage(nitro, cacheStorage)
          }
          ;(config as { nitro?: unknown }).nitro = nitro
        },
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
        inspect: () => ({
          providerOutput: describeDeploymentPlanOutput(plan, deploymentRoot ?? process.cwd(), deploymentOutputDir),
        }),
      },
      config(config) {
        deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
        if (deploymentEnvPlugin.current) subscribeEnvPlugin(deploymentEnvPlugin.current)
        if (plan.preset !== "cloudflare") return
        if ((config as { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean })[VITEHUB_NITRO_CONFIG_CONTEXT] === true) {
          const viteConfig = config as { nitro?: unknown }
          viteConfig.nitro = composeNitroCloudflareProviderOutput(useProviderOutputCatalog(config), viteConfig.nitro)
        }
      },
      configResolved(config) {
        // SAFETY: Vite preserves the user-defined Nitro field on the resolved config, while ResolvedConfig omits framework extensions from its type.
        const inspectionNitro = (config as ResolvedConfig & { nitro?: { rootDir?: string, output?: { dir?: string } } }).nitro
        deploymentRoot = resolve(inspectionNitro?.rootDir ?? config.root ?? process.cwd())
        deploymentOutputDir = inspectionNitro?.output?.dir
        const serverResolve = resolveServerOptions(config)
        const buildConfig = {
          alias: (serverResolve.alias ?? []).map(alias => ({
            customResolver: alias.customResolver !== undefined,
            find: alias.find,
            replacement: alias.replacement,
          })),
          conditions: serverResolve.conditions,
          define: resolveViteHubBundleDefines(config),
          extensions: serverResolve.extensions,
          hasScheduleIntegration: config.plugins?.some(plugin => plugin.name === "@vite-hub/schedule/vite") ?? false,
          mainFields: serverResolve.mainFields,
          preserveSymlinks: serverResolve.preserveSymlinks,
        }
        // SAFETY: Nitro extends resolved Vite configuration with optional host settings, which cloneRecord validates.
        const nitroConfig = cloneRecord((config as { nitro?: unknown }).nitro)
        for (const module of Array.isArray(nitroConfig.modules) ? nitroConfig.modules : []) {
          const buildConfigRef = resolvedBuildConfigs.get(module)
          if (buildConfigRef) buildConfigRef.current = buildConfig
        }
        providerOutput = useProviderOutputCatalog(config)
        if (plan.preset === "cloudflare") {
          deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
          if (deploymentEnvPlugin.current) subscribeEnvPlugin(deploymentEnvPlugin.current)
          const viteConfig = config as typeof config & { nitro?: unknown }
          viteConfig.nitro = composeNitroCloudflareProviderOutput(useProviderOutputCatalog(config), viteConfig.nitro)
        }
        const nitro = cloneRecord((config as { nitro?: unknown }).nitro)
        deployCommandOwned = typeof cloneRecord(nitro.commands).deploy === "string"
        if (config.command === "build" && nitro.preset !== nitroPreset) {
          throw viteHubErrorDiagnostics.VITE_HUB_R0083({ message: "[vitehub] The " + JSON.stringify(plan.preset) + " deployment plan requires Nitro preset " + JSON.stringify(nitroPreset) + "." })
        }
      },
      buildStart() {
        providerOutputGenerations.capture(this, providerOutput)
      },
      async buildEnd(error) {
        if (error) await providerOutputGenerations.reset(this, providerOutput, error)
      },
      async renderError(error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
      },
      closeBundle: {
        order: "post",
        sequential: true,
        async handler() {
          await finalizeProviderDeploymentOutputs(providerOutput)
        },
      },
    } as Plugin,
  ]
}

function hasExplicitBlobStore(options: boolean | BlobOptions | undefined): boolean {
  return Boolean(options && typeof options === "object" && ("driver" in options || "stores" in options))
}

const presetBlobConfigs = new WeakSet<object>()

function presetBlobOptions(
  plan: DeploymentPlan,
  options: boolean | BlobOptions | undefined,
  deploymentName = "vitehub-blob",
): BlobOptions {
  if (hasExplicitBlobStore(options)) return options as BlobOptions
  const configured = options && typeof options === "object" ? options : {}
  const fromPreset = (blob: Exclude<BlobOptions, false>) => {
    presetBlobConfigs.add(blob)
    return blob
  }
  switch (plan.services.blob.supported && plan.services.blob.adapter) {
    case "cloudflare-r2": return fromPreset({
      bucketName: process.env.BLOB_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET_NAME || process.env.R2_BUCKET_NAME || deploymentName,
      ...configured,
      driver: "cloudflare-r2",
    })
    case "fs": return fromPreset({ ...configured, driver: "fs" })
    case "netlify-blobs": return fromPreset({ name: "vitehub-blob", ...configured, driver: "netlify-blobs" })
    case "vercel-blob": return fromPreset({ ...configured, driver: "vercel-blob" })
    default: throw viteHubErrorDiagnostics.VITE_HUB_R0084({ message: "[vitehub] Missing Blob adapter for deployment preset " + JSON.stringify(plan.preset) + "." })
  }
}

function normalizePublicUrl(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined
  // WHATWG URL parsing drops empty userinfo, so inspect the original authority
  // to reject credential syntax such as `https://@host` as well.
  const authority = value.trim().match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
  if (!url || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || authority?.includes("@")) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0124({ message: `[vitehub] publicUrl must be an http(s) origin without a path, received ${JSON.stringify(value)}.` })
  }
  return url.origin
}

const addRuntimeNoExternal = createNoExternalAddition("@vite-hub/runtime")

function publicUrlPlugin(publicUrl: ViteHubOptions["publicUrl"], signedConsole: boolean): Plugin & ViteHubCliContributingPlugin {
  return {
    name: "vite-hub/public-url",
    // `channels sync` and `channels history` use one public origin as their default `--url`.
    ...(typeof publicUrl === "string" ? { vitehub: { cli: () => ({ namespaces: [], publicUrl: normalizePublicUrl(publicUrl) }) } } : {}),
    config(config, { command }) {
      // Signed Node requests need a configured deployment origin in development too.
      if (publicUrl === undefined || (command !== "build" && !signedConsole)) return
      let resolved: PublicUrlConfig
      if (typeof publicUrl === "function") {
        const root = resolveViteHubProjectRoot(config.root ?? process.cwd())
        // SAFETY: ViteHub hosts add this private server-directory symbol before plugins read the config.
        const serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
        resolved = { agents: Object.fromEntries((ownerModules.agentVite?.discoverAgentDefinitionEntries(root, serverDirs) ?? []).map(({ name }) => [name, normalizePublicUrl(publicUrl(name))])) }
      }
      else resolved = { url: normalizePublicUrl(publicUrl) }
      const define = JSON.stringify(resolved)
      // Nuxt can build Nitro outside Vite (`experimental.nitroViteEnvironment: false`). That build reads Nitro
      // `replace`, not Vite `define`. Change the replayed Nitro config in place, as Vite concatenates returned arrays.
      if ((config as { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean })[VITEHUB_NITRO_CONFIG_CONTEXT] === true) {
        const host = config as { nitro?: Record<string, unknown> }
        const nitro = host.nitro ?? {}
        const replace = nitro.replace && typeof nitro.replace === "object" ? nitro.replace : {}
        nitro.replace = { ...replace, __VITEHUB_PUBLIC_URL__: define }
        host.nitro = nitro
      }
      return { define: { __VITEHUB_PUBLIC_URL__: define } }
    },
    configEnvironment(name, config, env) {
      // The shared URL helper reads the public URL and app base defines, so server code must inline it.
      // In `vite dev`, Nitro loads it with Node, and the dev defines plugin sets the same values as globals.
      if (!isServerEnvironment(name, config) || loadsViteHubPackagesNatively(name, env)) return
      const noExternal = addRuntimeNoExternal(config.resolve?.noExternal)
      if (noExternal) return { resolve: { noExternal } }
    },
  }
}

// Vite Doctor reads `api.doctor` from installed plugins and loads the extension only during a Doctor Run.
function doctorPlugin(): Plugin {
  return {
    name: "vite-hub/doctor",
    api: {
      doctor: {
        extensions: [() => import("./doctor.ts")],
      } satisfies DoctorPluginApi,
    },
  }
}

/**
 * The ViteHub plugin list. When `server/content.ts` selects the `cms` preset of `@vite-hub/cms` and `database`,
 * `blob`, or `workspace` is unset, ViteHub turns that feature on. When it imports `github()` and `kv` is unset, ViteHub
 * turns KV on for the head commits of the Sources. See `withCmsPresetPlugins()`.
 */
/** Builds the ViteHub plugin list for one resolved feature configuration. */
function createViteHubPlugins(options: ViteHubOptions): PluginOption[] {
  if (!options || typeof options !== "object") throw viteHubErrorDiagnostics.VITE_HUB_R0085({ message: "vitehub() requires a built-in deployment preset." })
  const preset = options.preset ?? detectPreset() ?? "node"
  // Keep `false`: it turns the Console off, and unset keeps the development operation RPC.
  options = withConnectionsDatabase(withDataDir({ ...options, preset, console: options.console === false ? false : resolveConsoleOptions(options.console) }))
  const configuredConsole = resolveConsoleOptions(options.console)
  const plan = resolveDeploymentPlan(preset)
  // Cloudflare has no durable local filesystem. Treat the shorthand database
  // option as the host-native D1 driver so implicit databases (for example,
  // the one enabled by Connections) are provisioned and bound like explicit
  // D1 configurations.
  if (plan.preset === "cloudflare" && options.database === true) options = { ...options, database: { driver: "d1" } }
  assertFeatureSupported("schedule", plan.preset, options)
  if (options.agent && options.agent !== true && options.agent.runtime === "deno" && plan.preset === "deno") {
    throw viteHubErrorDiagnostics.VITE_HUB_R0087({ message: "[vitehub] The \"deno\" preset cannot deploy the Agent Deno runtime because its generated server is outside the deployed Nitro entrypoint. Use the preset's Nitro runtime or compose an explicit Deno Agent deployment." })
  }
  const configuredAgent = options.agent && options.agent !== true ? options.agent : undefined
  const defaultInvocations = configuredAgent?.invocations
  if (options.agent && defaultInvocations !== false) {
    const store = typeof defaultInvocations === "object" ? defaultInvocations.store : defaultInvocations
    if (store === "database" && !options.database) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0131({ message: "[vitehub] agent.invocations \"database\" requires database. Set database in vitehub()." })
    }
    if (configuredAgent?.runtime === "deno" || plan.preset === "netlify") {
      throw viteHubErrorDiagnostics.VITE_HUB_R0132({ message: "[vitehub] agent.invocations requires Nitro-hosted Agents. Netlify and Deno Agent output are not supported. Set agent.invocations to false and configure invocations on each Agent Definition." })
    }
  }
  assertFeatureSupported("browser", plan.preset, options)
  assertFeatureSupported("email", plan.preset, options)
  const sandboxTaskEnabled = options.sandboxTask === true && plan.services.sandbox.supported
  const blobEnabled = Boolean(options.blob) && (plan.services.blob.supported || hasExplicitBlobStore(options.blob))
  const configuredQueue = options.queue && options.queue !== true ? options.queue : undefined
  const observability = options.observability === true ? {} : options.observability || undefined
  const { logs: logsOption, ...observabilityOptions } = observability ?? {}
  const observabilityLogs = logsOption === true ? {} : logsOption || undefined
  const telemetry = Boolean(observabilityOptions.service)
  const workflowEnabled = options.workflow !== false
    && Boolean(options.workflow || (options.agent && plan.preset !== "netlify"))
  // The packages of these features are optional peers. One error lists every package that the app must add.
  assertFeaturePackages(([
    ["agent", options.agent || telemetry],
    ["auth", options.auth],
    ["blob", blobEnabled],
    ["browser", options.browser],
    ["channels", options.channels],
    ["comments", options.comments],
    ["console agents", configuredConsole && options.agent],
    ["console mcp-client", isConsoleMcpClientEnabled(configuredConsole)],
    ["connections", options.connections],
    // `withConnectionsDatabase()` turns `database` on for Connections, so name the feature that the app enabled.
    ["database", options.database && !options.connections],
    ["email", options.email],
    ["i18n", options.i18n],
    // `cache: { driver: "kv" }` stores the cache in KV.
    ["kv", options.kv || (options.cache && options.cache !== true && options.cache.driver === "kv")],
    ["queue", options.queue && plan.services.queue.supported],
    ["rateLimit", options.rateLimit],
    ["mcp", options.mcp],
    ["realtime", options.realtime],
    ["sandboxTask", sandboxTaskEnabled],
    ["schedule", options.schedule],
    // Agents run on Workflow outside Netlify unless the app sets `workflow: false`.
    ["workflow", workflowEnabled],
    ["workspace", options.workspace],
  ] as const).filter(([, enabled]) => enabled).map(([feature]) => feature))
  const { blobVite, browserVite, channelsVite, connectionsVite, emailVite, kvVite, markdownTemplateVite, queueVite, rateLimitVite, sandboxTaskVite, workflowVite } = ownerModules
  const configuredBlob = blobEnabled ? presetBlobOptions(plan, options.blob) : undefined
  const resolvedConsoleBlob = configuredBlob
    ? requireOptionalOwner(blobVite, "blob").resolveBlobViteConfig(configuredBlob, { hosting: plan.nitroPreset }).blob
    : false
  const consoleBlobStores = resolvedConsoleBlob
    ? Object.keys(resolvedConsoleBlob.stores || { default: resolvedConsoleBlob.store })
    : []
  const consoleSections = resolveConsoleSectionIds({ ...options, env: options.env !== false, blob: blobEnabled, preset: plan.preset, sandboxTask: sandboxTaskEnabled })
  // `.template.md` imports work when the app installed `@vite-hub/markdown-template`.
  const plugins: unknown[] = [doctorPlugin(), ...markdownTemplateVite ? [markdownTemplateVite.hubMarkdownTemplate()] : []]
  const requestedServices: HostSelectedService[] = []
  if (options.blob !== undefined && options.blob !== false && !hasExplicitBlobStore(options.blob)) requestedServices.push("blob")
  if (options.queue) requestedServices.push("queue")
  if (options.rateLimit) requestedServices.push("rateLimit")
  if (options.sandboxTask) requestedServices.push("sandbox")
  const manifestServices = hasExplicitBlobStore(options.blob)
    ? { ...plan.services, blob: { configured: true, supported: true } }
    : plan.services
  if (observabilityOptions.posthog && options.env === false) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0126({ message: "[vitehub] observability.posthog reads its API key from Server Env. Remove env: false." })
  }
  if (observabilityOptions.posthog && options.env && options.env.server?.observability !== undefined) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0128({ message: "[vitehub] env.server.observability is reserved for vitehub({ observability })." })
  }
  const envPlugin = options.env === false
    ? undefined
    : hubEnv({
        ...options.env,
        // Declared here so the Console Env page shows it, and the observability plugin reads it at startup.
        ...(observabilityOptions.posthog ? { server: { ...options.env ? options.env.server : undefined, observability: { posthog: { apiKey: observabilityOptions.posthog.apiKey } } } } : {}),
        runtimeImports: {
          secret: "vite-hub/env",
          server: envServerRuntimeImport,
          ...options.env?.runtimeImports,
        },
      })
  if (options.agent && envPlugin) {
    // Read the root and declarations after ordinary config hooks. The pre plugin's
    // post config hook declares Channel Env before this registry hook runs.
    const configHook = envPlugin.config
    if (configHook) envPlugin.config = {
      order: "post",
      handler: "handler" in configHook ? configHook.handler : configHook,
    }
    plugins.push(agentChannelEnvPlugin())
  }
  plugins.push(...deploymentPlugins(plan, requestedServices, blobEnabled, manifestServices, options, envPlugin))
  plugins.push(publicUrlPlugin(options.publicUrl, Boolean(configuredConsole) && configuredConsole?.auth !== false))
  plugins.push(devDefinesVitePlugin())
  plugins.push(standardContextVitePlugin())
  const providerImportAliases: Record<string, string> = {}
  const configuredKV = options.kv && options.kv !== true ? options.kv : undefined
  // hubKv() gets the preset only when `kv` is enabled; through the cache alone, it infers the host from env.
  const kvHosting = options.kv ? plan.nitroPreset : undefined
  configureProviderOptionalImportAliases(providerImportAliases, options, configuredKV, kvHosting)
  const workspaceDependencyRuntimeImports = frameworkWorkspaceDependencyRuntimeImports(
    sandboxTaskEnabled ? requireOptionalOwner(sandboxTaskVite, "sandboxTask").sandboxTaskRuntimeStateModule : undefined,
  )
  if (workspaceDependencyRuntimeImports.shellWorkspace && (options.agent || workflowEnabled || sandboxTaskEnabled)) {
    plugins.push(workspaceShellPlugin(workspaceDependencyRuntimeImports))
  }

  if (!options.database) {
    const databaseRuntimeImports = new Map<string, string>()
    for (const specifier of ["vite-hub/database/drizzle", "@vite-hub/database/drizzle"]) {
      databaseRuntimeImports.set(specifier, specifier)
      // Vite applies the framework alias first, so resolveId can receive the facade path.
      const facade = frameworkProviderImportAliases[specifier]
      if (facade) databaseRuntimeImports.set(facade, specifier)
    }
    plugins.push(databaseDisabledPlugin(databaseRuntimeImports, options.database === false))
  }
  plugins.push(unavailableServicesPlugin(plan, { browser: Boolean(options.browser), realtime: Boolean(options.realtime) }))
  if (plan.preset === "cloudflare") plugins.push(cloudflareShSyntaxPlugin(), cloudflarePkceChallengePlugin())
  plugins.push(frameworkDependencyResolver(options, envPlugin, providerImportAliases, blobEnabled, configuredKV, kvHosting))

  // `logs: { source }` reads an existing pipeline, so without `service` it starts no logger.
  const evlogRegistered = Boolean(observability) && (telemetry || !(observabilityLogs && "source" in observabilityLogs))
  if (observability) {
    if (observabilityOptions.papercuts && !(configuredConsole && options.agent)) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0127({ message: "[vitehub] observability.papercuts stores reports in the Console invocation journal. Enable agent and console." })
    }
    if (evlogRegistered) plugins.push(observabilityVitePlugin(observabilityOptions, { agent: options.agent, hosting: plan.nitroPreset }))
  }
  if (observabilityLogs) plugins.push(logsVitePlugin(observabilityLogs))
  if (!evlogRegistered || observabilityOptions.evlog?.enabled === false) plugins.push(errorLogVitePlugin())
  if (envPlugin) plugins.push(envPlugin)

  const runtimeCapabilityImports = {
    blob: blobEnabled ? "vite-hub/blob" : false,
    connections: options.connections ? generatedModules.connectionsAgent : false,
    console: configuredConsole ? "vite-hub/console/server" : false,
    db: options.database ? "vite-hub/database/drizzle" : false,
    i18n: options.i18n ? "vite-hub/i18n/server" : false,
    // Email and KV capabilities exist only when the app installed their packages.
    ...emailVite ? { email: "vite-hub/email/server" } : {},
    ...kvVite ? { kv: "vite-hub/kv" } : {},
  } satisfies Record<string, false | string>

  plugins.push(setupDevPlugin())
  plugins.push(operationsCheckPlugin())
  // Without a `console` option, `vite dev` serves the operation RPC and the development Setup page.
  // `console: false` turns the RPC off.
  const devOperationsOnly = options.console === undefined
  if (configuredConsole || devOperationsOnly) {
    const invocationRootState = {}
    const consolePlugin = consoleVitePlugin({
      contentImportBase: "vite-hub/content",
      blobStores: consoleBlobStores,
      console: configuredConsole || undefined,
      rpcOnly: devOperationsOnly,
      runtimeCapabilityImports,
      databaseDiscoveryRoot: options.database && options.database !== true ? options.database.projectRoot : undefined,
      rateLimitDiscoveryRoot: options.rateLimit && options.rateLimit !== true ? options.rateLimit.projectRoot : undefined,
      rateLimitScanDirs: options.rateLimit && options.rateLimit !== true ? options.rateLimit.scanDirs : undefined,
      resolveAuthConfig: options.auth
        ? (root, serverDirs) => requireOptionalOwner(ownerModules.authVite, "auth").resolveAuthViteConfig(
            options.auth === true ? undefined : options.auth,
            root,
            { serverDirs },
          )
        : undefined,
      resolveBlobStores: (blob) => {
        if (blob === false) return false
        if (blob === undefined && !options.blob) return false
        const resolved = requireOptionalOwner(blobVite, "blob").resolveBlobViteConfig(
          // SAFETY: The Console plugin passes the Blob options that the deployment hook resolved for this config.
          (blob ?? configuredBlob) as BlobOptions | undefined,
          { hosting: plan.nitroPreset },
        ).blob
        return resolved ? Object.keys(resolved.stores || { default: resolved.store }) : false
      },
      resolveKV: (kv, plugins) => {
        // SAFETY: The canonical KV plugin name identifies its framework-owned configuration API.
        const kvPlugin = plugins?.find(plugin => plugin.name === "@vite-hub/kv/vite") as { api?: KVVitePluginAPI } | undefined
        if (kvPlugin?.api?.getConfig) return Boolean(kvPlugin.api.getConfig().kv)
        if (kv === false) return false
        if (kv === undefined && !options.kv) return false
        const resolved = requireOptionalOwner(kvVite, "kv").resolveKVViteConfig(
          // SAFETY: The Console plugin passes KV options of the same shape.
          (kv ?? configuredKV) as KVOptions | undefined,
          { hosting: plan.nitroPreset },
        ).kv
        return Boolean(resolved)
      },
      scheduleDiscoveryRoot: options.schedule && options.schedule !== true ? options.schedule.projectRoot : undefined,
      workspaceDiscoveryRoot: options.workspace && options.workspace !== true ? options.workspace.projectRoot : undefined,
      invocationRootState,
      operationSections: devOperationsOnly ? consoleSections : undefined,
      // The dev-only RPC lists no sections, so it starts no Agent journal or other Console state.
      // Schedules is the exception: `vitehub schedule run` runs only the manual Schedules that its section installs.
      sections: devOperationsOnly ? consoleSections.filter(section => section === "schedules") : consoleSections,
    })
    if (devOperationsOnly) consolePlugin.apply = "serve"
    plugins.push(consolePlugin)
    if (options.agent && !devOperationsOnly) plugins.push(consoleInvocationRootPlugin(undefined, undefined, invocationRootState))
  }

  if (options.auth) {
    plugins.push(requireOptionalOwner(ownerModules.authVite, "auth").hubAuth(
      options.auth === true ? {} : options.auth || false,
      {
      importBase: "vite-hub/auth",
      },
    ))
  }
  if (sandboxTaskEnabled) {
    const sandboxTaskPolicy = plan.services.sandbox
    plugins.push(afterApplicationConfig(requireOptionalOwner(sandboxTaskVite, "sandboxTask").hubSandboxTask({
      ...(sandboxTaskPolicy.supported ? { provider: sandboxTaskPolicy.adapter } : {}),
      providerImportAliases,
      providerImportSpecifier: "vite-hub/sandbox/task",
    } as SandboxTaskOptions)))
  }
  if (options.agent) {
    // The generated plugin installs the journal, with the Console on or off, so the Console only reads it.
    const { invocations: _invocations, ...agentOptions } = options.agent === true ? {} : options.agent
    if (defaultInvocations !== false || options.database) {
      plugins.push(agentInvocationsVitePlugin({
        database: Boolean(options.database),
        default: defaultInvocations,
        preset: plan.preset,
        resolveD1Binding: (root, serverDirs) => defaultDatabaseD1Binding(plan.preset, options.database, { implicitDefault: true, root, serverDirs }),
      }))
    }
    plugins.push(requireOptionalOwner(ownerModules.agentVite, "agent").hubAgent({
      ...agentOptions,
      kvImport: "vite-hub/kv",
      processDiscordGateway: plan.preset === "node",
      providerImportAliases,
      runtimeCapabilityImports: {
        ...runtimeCapabilityImports,
        // Present only with the Auth plugin. It reads users only for Actors that authenticated() resolved.
        auth: "vite-hub/auth/agent",
      },
      ...(workflowEnabled ? { workflowModules: { index: "vite-hub/workflow", state: requireOptionalOwner(workflowVite, "workflow").workflowRuntimeModule("state") } } : {}),
      workspaceDependencyRuntimeImports,
    } as AgentPluginOptions))
  }
  if (options.browser) plugins.push(requireOptionalOwner(browserVite, "browser").hubBrowser(options.browser === true ? undefined : options.browser))
  if (options.channels) plugins.push(requireOptionalOwner(channelsVite, "channels").hubChannels(options.channels === true ? undefined : options.channels))
  if (options.connections) {
    const { database: databaseName, ...connections } = options.connections === true ? {} : options.connections
    const connectionsOptions: ConnectionsVitePluginOptions = { ...connections, database: "vite-hub/database/drizzle", ...(databaseName !== undefined ? { databaseName } : {}), importBase: "vite-hub/connections" }
    plugins.push(requireOptionalOwner(connectionsVite, "connections").hubConnections(connectionsOptions))
  }
  else if (connectionsVite) plugins.push(connectionsVite.hubConnectionsTypesCleanup())
  if (options.database) plugins.push(requireOptionalOwner(ownerModules.databaseVite, "database").hubDb(options.database === true ? undefined : options.database))
  if (blobEnabled) {
    plugins.push(afterApplicationConfig(requireOptionalOwner(blobVite, "blob").hubBlob(configuredBlob, { importBase: "vite-hub/blob", presetDriver: blob => Boolean(blob && presetBlobConfigs.has(blob)) })))
  }
  if (options.email) {
    const emailOptions = options.email === true
      ? { driver: "cloudflare-email" as const }
      : options.email
    plugins.push(requireOptionalOwner(emailVite, "email").hubEmail({
      ...emailOptions,
      hosting: plan.nitroPreset,
      runtimeEnvImport: envServerRuntimeImport,
      workflowProvider: options.workflow && options.workflow !== true ? options.workflow.provider : undefined,
    } as EmailOptions))
  }
  else if (emailVite) plugins.push(emailVite.hubEmailOptionalPeerResolver())
  // A KV cache also needs the owner plugin when no KV options were set.
  if (options.kv || (options.cache && options.cache !== true && options.cache.driver === "kv")) {
    // hubKv() infers the driver itself, because development keeps inferred stores local unless they set `remote: true`.
    plugins.push(requireOptionalOwner(kvVite, "kv").hubKv(configuredKV, { ...(kvHosting ? { hosting: kvHosting } : {}), databaseImport: "vite-hub/database/drizzle" }))
  }
  else if (kvVite) plugins.push(kvVite.hubKvOptionalPeerResolver())
  if (options.queue && plan.services.queue.supported) {
    const provider = configuredQueue?.provider ?? plan.services.queue.adapter
    // SAFETY: The provider is the host's Queue adapter or the app's own `queue.provider`.
    plugins.push(afterApplicationConfig(requireOptionalOwner(queueVite, "queue").hubQueue({ ...configuredQueue, provider } as QueueOptions, { importBase: "vite-hub/queue" })))
  }
  if (options.i18n) {
    // SAFETY: ViteHub adds the public import path of its re-exports to the public i18n options.
    plugins.push(requireOptionalOwner(ownerModules.i18nVite, "i18n").hubI18n({ ...options.i18n, importBase: "vite-hub/i18n" } as I18nOptions))
  }
  if (options.bundle) plugins.push(hubBundle())
  if (options.mcp) {
    const mcpConfig: McpOptions = options.mcp === true ? {} : options.mcp
    const { auth: mcpAuth = Boolean(options.auth), ...mcpOptions } = mcpConfig
    if (mcpAuth && !options.auth) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0141({ message: "[vitehub] mcp.auth needs Auth. Set auth in vitehub() and add mcpOAuth() from vite-hub/auth/mcp to server/auth.ts, or set mcp: { auth: false } for a public MCP server." })
    }
    plugins.push(requireOptionalOwner(ownerModules.mcpVite, "mcp").hubMcp({
      ...mcpOptions,
      auth: mcpAuth,
      imports: { authMcp: "vite-hub/auth/mcp", runtime: "@vite-hub/mcp/runtime" },
      ...(options.name ? { name: options.name } : {}),
    }))
  }
  if (options.rateLimit) {
    const rateLimitPolicy = plan.services.rateLimit
    plugins.push(afterApplicationConfig(requireOptionalOwner(rateLimitVite, "rateLimit").hubRateLimit({
      ...(options.rateLimit === true ? {} : options.rateLimit),
      provider: rateLimitPolicy.supported ? rateLimitPolicy.adapter : "memory",
    })))
  }
  // Comments in `server/comments.ts`, or with the `comments` option: threads in the Database, the overlay on pages in
  // comment mode, and page presence rooms where Realtime has an authority. Inert without either, and absent without its
  // package.
  const commentsPlugin = options.comments === false ? undefined : ownerModules.commentsVite?.hubComments({
    ...options.comments === true ? {} : options.comments,
    enabled: Boolean(options.comments),
    auth: Boolean(options.auth),
    // Attachments go to the app's Blob store.
    blob: blobEnabled,
    imports: {
      auth: generatedModules.commentsRuntimeAuth,
      blob: "vite-hub/blob",
      contentClient: "vite-hub/content/client",
      database: "vite-hub/comments/database",
      databases: "vite-hub/database/drizzle",
      realtime: generatedModules.commentsRealtime,
      runtime: "vite-hub/comments/runtime",
    },
  })
  if (options.realtime) {
    plugins.push(requireOptionalOwner(ownerModules.realtimeVite, "realtime").hubRealtime({
      ...(options.realtime === true ? {} : options.realtime),
      importBase: "vite-hub/realtime",
      // Content edits Markdown documents live, and Comments shows who is on a page, where Realtime has a room authority.
      // Other hosts keep one Content editor at a time and show comments without presence.
      contribute: async (context) => {
        const [content, comments] = await Promise.all([
          ownerModules.contentVite?.contributeContentRealtime({
            ...context,
            contentImport: "vite-hub/content/realtime",
            realtimeImport: "vite-hub/realtime/server",
            ...(configuredConsole ? { console: { module: generatedModules.consoleSections, section: "content" } } : {}),
          }),
          commentsPlugin?.api.contributeRealtime(context),
        ])
        return {
          definitions: [...content?.definitions ?? [], ...comments?.definitions ?? []],
          plugins: content?.plugins ?? [],
        }
      },
    }))
  }
  if (options.schedule) {
    plugins.push(requireOptionalOwner(ownerModules.scheduleVite, "schedule").hubSchedule({
      ...(plan.preset === "vercel" ? { providerOutput: "standalone" as const } : {}),
      ...(options.schedule === true ? {} : options.schedule),
      databaseImport: "vite-hub/database/drizzle",
      importBase: "vite-hub/schedule",
      providerImportAliases,
    } as ScheduleOptions))
  }
  if (workflowEnabled) {
    plugins.push(requireOptionalOwner(workflowVite, "workflow").hubWorkflow(
      options.workflow && options.workflow !== true ? options.workflow : {},
      {
      hosting: plan.nitroPreset,
      importBase: "vite-hub/workflow",
      ...(options.workflow === undefined ? { implicitlyEnabled: true } : {}),
      providerImportAliases,
      includeUserAppEntry: options.workflow !== undefined && options.workflow !== false,
      workspaceDependencyRuntimeImports,
      // With the Agent, Workspace may be installed only as an Agent dependency, so the Agent hands out its path.
      workspaceRuntimeModule: options.agent ? requireOptionalOwner(ownerModules.agentVite, "agent").agentRuntimeModule("internal/workspace/runtime") : "vite-hub/workspace/runtime",
      },
    ))
  }
  if (options.workspace) {
    // SAFETY: ViteHub supplies its internal hosting context in addition to the public Workspace options.
    plugins.push(requireOptionalOwner(ownerModules.workspaceVite, "workspace").hubWorkspace({
      ...(options.workspace === true ? {} : options.workspace),
      hosting: plan.nitroPreset,
    } as WorkspaceOptions))
  }
  const sourcePlugin = hubSource({
    auth: options.auth
      ? ({ projectRoot, serverDirs }) => Boolean(requireOptionalOwner(ownerModules.authVite, "auth").resolveAuthViteConfig(
          options.auth === true ? undefined : options.auth,
          projectRoot,
          { serverDirs },
        ))
      : false,
    contentImportBase: "vite-hub/content",
    importBase: "vite-hub/source",
  })
  plugins.push(sourcePlugin)
  // Adds the `vitehub content` commands, the Content operations, and the Content inspector. Inert without server/content.ts.
  if (ownerModules.contentVite) plugins.push(ownerModules.contentVite.hubContent())
  // Forms in `server/forms/<name>.ts`: one route for each, submissions in the Database, email with Email, and the user
  // with Auth. Inert without the folder, and absent without its package.
  if (ownerModules.formsVite) plugins.push(ownerModules.formsVite.hubForms({
    database: Boolean(options.database),
    email: Boolean(options.email),
    auth: Boolean(options.auth),
    imports: {
      runtime: "vite-hub/forms/runtime",
      operations: "vite-hub/forms/operations",
      database: "vite-hub/forms/database",
      databases: "vite-hub/database/drizzle",
      email: "vite-hub/email/server",
      auth: "vite-hub/auth/server",
      standard: "vite-hub/runtime",
    },
  }))
  // Reads the `cms` preset and contributes its Workspace, Database tables, and, when the app has none, the default
  // Database. Inert without the preset.
  if (ownerModules.cmsVite) plugins.push(ownerModules.cmsVite.hubCms({
    imports: {
      blob: "vite-hub/blob",
      blobDatabase: "vite-hub/workspace/blob-database",
      contentDatabase: "vite-hub/content/database",
      database: "vite-hub/database/drizzle",
      workspace: "vite-hub/workspace",
    },
  }))
  if (commentsPlugin) plugins.push(commentsPlugin)
  else if (options.comments === false) plugins.push(commentsOffPlugin())
  if (!ownerModules.commentsVite || !ownerModules.contentVite || !ownerModules.cmsVite || !ownerModules.formsVite) plugins.push(optionalOwnerEntriesPlugin({ database: options.database !== false }))
  plugins.push(optionalOwnerImportsPlugin())
  // Nitro tasks in `server/tasks/`, listed and run with `vitehub task`.
  plugins.push(viteHubTaskPlugin())
  // A Node server prints where each primitive keeps its state, and fails at boot when several instances would split it.
  if (plan.preset === "node") plugins.push(viteHubDurabilityPlugin(options.node))
  // Lets request-scoped checks, such as Content preview, keep a request out of Nitro's cache.
  plugins.push(nitroCacheBypass())
  plugins.push(viteHubTypesPlugin({
    additionalProjectRoots: options.connections && options.connections !== true && options.connections.projectRoot ? [options.connections.projectRoot] : [],
    disabledTypeFiles: [...workflowEnabled ? [] : ["workflow.d.ts"], ...blobEnabled ? [] : ["types/blob.d.ts"]],
    prepareSources: sourcePlugin.api.prepareSources,
  }))
  // Nitro is the host output. These plugins run its config hooks after ViteHub's, whether `vitehub()` includes Nitro
  // or the app adds `nitro()` itself.
  plugins.push(...nitroOrderPlugins())
  // SAFETY: Each branch above contributes Vite-compatible plugins or nested plugin options.
  return plugins as PluginOption[]
}

/**
 * The ViteHub plugins without Nitro. `vitehub()` adds Nitro's Vite plugin to them. `vite-hub/nuxt` uses them as they
 * are, because Nuxt runs its own Nitro, so it never loads `nitro/vite`.
 */
export function viteHubPlugins(options: ViteHubOptions): PluginOption[] {
  return withCmsPresetPlugins(withComments(options), resolved => createViteHubPlugins(resolved))
}
