import { agentJournalStateUrl, defaultDatabaseD1Binding, withComments, withConnectionsDatabase, withDataDir } from "./storage-config.ts"
import { applyCacheStorage, resolveCacheStorage, type CacheOptions } from "./cache-storage.ts"
import { existsSync, readFileSync } from "node:fs"
import { invariant } from "@vite-hub/internal/invariant"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import frameworkPackageManifest from "../package.json" with { type: "json" }

import { defaultServerConditions, loadEnv } from "vite"

import type { HubCommentsOptions } from "@vite-hub/comments/vite"
import { describeServerEnv } from "@vite-hub/env/server"
import { hubEnv } from "@vite-hub/env/vite"
import { hubBundle } from "@vite-hub/bundle/vite"
import { hubSource } from "@vite-hub/source/vite"
import { viteHubHintsPlugin } from "@vite-hub/internal/hints"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { collapseWranglerConfigFile } from "@vite-hub/internal/build/cloudflare"
import { collectDeploymentEnv, describeDeploymentPlanOutput, finalizeDeploymentPlanOutput, mergeDeploymentEnv } from "@vite-hub/internal/build/deployment-plan-output"
import type { DeploymentDeployManifest, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import { denoServerPackagesPlugin, finalizeDenoDeploymentOutput, type DenoServerPackages } from "@vite-hub/internal/build/deno-runtime-packages"
import { nitroCacheBypass } from "@vite-hub/internal/build/nitro-cache-bypass"
import { createNoExternalAddition, getDeploymentHost, isProductionBuild, isServerEnvironment, loadsViteHubPackagesNatively, resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, setResolvedFeatureOptions, VITEHUB_DEPLOYMENT_HOST, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS, workerdDependencyConfig, type ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import { findProviderHostConflict, hostFromNitroPreset, normalizeNitroPreset, resolveBuildHost, resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { formatDiagnostic } from "nostics"

import { viteHubTypesPlugin } from "./internal/types.ts"
import { assertEmailBuildDriver, assertFeatureSupported, assertHostService, defaultEmailDriver } from "./internal/feature-support.ts"
import type { HostSelectedService } from "./internal/feature-support.ts"
import { assertFeaturePackages, forgetPackageChecks, hostFeaturePackages, isPackageInstalled, isPackageInstalledInApp, optionalFeaturePackages, requireOptionalOwner } from "./internal/optional-owners.ts"
import { commentsOffPlugin, optionalOwnerEntriesPlugin, optionalOwnerImportsPlugin, ownerFacadeFeature, ownerModules } from "./internal/owner-modules.ts"
import { featureOptionsResolved, withCmsPresetPlugins } from "./internal/cms-preset-features.ts"
import { definitionFeaturesRootPlugin, resolveDefinitionFeatures } from "./internal/definition-features.ts"
import { assertNoRemovedViteHubOptions } from "./removed-options.ts"
import { withPrintedDiagnostics } from "./hook-errors.ts"
import { disabledRedisDriver, disabledUpstashDriver, hasRedisStore, hasUpstashStore, redisDriverSpecifier, upstashDriverSpecifier } from "./internal/kv-runtime.ts"
import { generatedModules } from "./internal/generated-modules.ts"
import { agentChannelEnvPlugin } from "./agent-channel-env.ts"
import { agentInvocationsVitePlugin } from "./agent-invocations-vite.ts"
import { devDefinesVitePlugin } from "./dev-defines-vite.ts"
import { vitestInlinePlugin } from "./vitest-inline.ts"
import { errorLogVitePlugin } from "./error-log-vite.ts"
import { defaultHealthRoute, healthVitePlugin, type HealthOptions } from "./health-vite.ts"
import { resolveDeployManifest, writeIndexNowKeyFile, type DeployOptions } from "./deploy-options.ts"
import { viteHubSeoPlugin, type SeoOptions } from "./seo/vite.ts"
import { requestPolicyVitePlugin, type SameOriginWritesOptions } from "./request-policy-vite.ts"
import { resolveSecurityPolicy, type SecurityOptions } from "./security-vite.ts"
import { redirectsVitePlugin, resolveRedirectsPolicy, type RedirectsOptions } from "./redirects-vite.ts"
import { staleChunkReloadVitePlugin } from "./stale-chunk-reload.ts"
import { standardContextVitePlugin } from "./standard-context-vite.ts"
import { databaseDisabledPlugin } from "./database-disabled.ts"
import { cloudflarePkceChallengePlugin } from "./cloudflare-pkce-challenge.ts"
import { cloudflareShSyntaxPlugin } from "./cloudflare-sh-syntax.ts"
import { cloudflareRedirectsFileVitePlugin } from "./cloudflare-redirects-vite.ts"
import { unavailableServicesPlugin } from "./unavailable-services.ts"
import { operationsCheckPlugin } from "./operations-check.ts"
import { setupDevPlugin } from "./setup-dev.ts"
import { consoleDeploymentEnv, consoleInvocationRootPlugin, consoleVitePlugin, resolveConsoleOptions, type ConsoleOptions } from "./console/vite.ts"
import { cloudflareExportConditions, type ViteHubHost } from "./deployment.ts"
import { writeDockerfile, type DockerfileBuild } from "./dockerfile.ts"
import { resolveSystemdUnit, systemdUnitName, writeSystemdUnit, type SystemdOptions } from "./systemd.ts"
import { cloudflareCustomDomainConfig, readProjectWranglerConfig } from "./cloudflare-custom-domain.ts"
import { addCloudflareVars, cloudflareServerEnvVars } from "./cloudflare-vars.ts"
import { nitroOrderPlugins } from "./nitro-order.ts"
import { viteHubTaskPlugin } from "./task/vite.ts"
import { viteHubCachePlugin } from "./cache/vite.ts"
import { viteHubServedSkillsPlugin } from "./skills/vite.ts"
import { viteHubDurabilityPlugin } from "./durability/vite.ts"
import { browserErrorsVitePlugin } from "./browser-errors-vite.ts"
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
import { loadAllEnv } from "@vite-hub/internal/vite-stage"
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

export type { CacheOptions } from "./cache-storage.ts"
export type { ConsoleOptions } from "./console/vite.ts"
export type { RedirectsOptions } from "./redirects-vite.ts"
export type { ObservabilityEvlogOptions, ObservabilityLogsOptions, ObservabilityOptions } from "./observability-vite.ts"
export type { HealthOptions } from "./health-vite.ts"
export type { DeployOptions } from "./deploy-options.ts"
export type { SeoOptions } from "./seo/vite.ts"
export type { SameOriginWritesOptions } from "./request-policy-vite.ts"
export type { SecurityHeaders, SecurityOptions } from "./security-vite.ts"
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
  // `vitehub migrate` tooling: generated server code never imports it.
  "@vite-hub/codemods": false,
  "@vite-hub/comments": true,
  "@vite-hub/connections": true,
  "@vite-hub/content": true,
  "@vite-hub/database": true,
  "@vite-hub/decisions": true,
  // Browser-only: generated server code never imports it.
  "@vite-hub/device": false,
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
  "@vite-hub/sync": true,
  "@vite-hub/ui": true,
  // Browser-only: generated server code never imports it.
  "@vite-hub/web-container": false,
  "@vite-hub/webhooks": true,
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
          throw viteHubErrorDiagnostics.VITE_HUB_R0075({ message: "[vitehub] Blob is unavailable for this host. Configure an explicit Blob store before using Blob APIs or Agent Capabilities." })
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
   * Writes the non-secret Server Env values set at build time to the Worker's `vars` in the generated `wrangler.json`.
   * ViteHub reads them from the process environment and the `.env` files Vite loads for the build mode. It never
   * writes a secret, a default, or a var that the Wrangler config already sets.
   */
  vars?: boolean
}

/** `connections` options of `vitehub()`. */
export type ConnectionsOptions = Omit<ConnectionsVitePluginOptions, "database" | "databaseName" | "importBase"> & {
  /** The Database that stores grants, approvals, and activity, such as `"users"`. Defaults to `default`. */
  database?: string
}

/** Options of the Nuxt client plugin of `@vite-hub/device`. */
export interface ViteHubDeviceOptions {
  /** The `version` of `openDevice()`. A change deletes the stored copies. Default: none, so a deploy keeps them. */
  version?: string
  /** `false`: the plugin does not name the account from Auth, and the app calls `setDeviceAccount()`. */
  account?: false
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
   * The host to build for. When omitted, `detectHost()` reads it from `VITEHUB_HOST`, `NITRO_PRESET`,
   * `SERVER_PRESET`, or the provider variables of Cloudflare Workers Builds, Netlify, Vercel, and Deno Deploy.
   * Without any of them, ViteHub builds for `"node"`. `vitehub deploy --host` overrides it for its build.
   */
  host?: ViteHubHost
  /**
   * The name of the app. Host resources, such as the Cloudflare Worker, use it in lower case with dashes, and the
   * Console shows it as written. Default: the `name` in `package.json`.
   */
  name?: string
  /**
   * Public origin of the deployed application, such as `https://agents.example.com`.
   * Console links, GitHub activity links, telemetry session links, the Auth base URL, and Connections OAuth callbacks use it.
   * A function receives each discovered Agent name. Builds only; `vite dev` uses the request origin.
   * Server code reads it with `resolvePublicUrl()` from `vite-hub/runtime`. A string is also the default `--url` of
   * `vitehub channels sync` and `channels history`, and on the `cloudflare` host it adds the custom-domain route
   * unless the app configures Worker routing.
   */
  publicUrl?: string | ((agentName: string) => string)
  /**
   * Redirect every request to one canonical address. `host` sends other hosts, such as `www.example.com`, to
   * `example.com`. `https` sends `http:` to `https:`. `trailingSlash` adds or removes the slash at the end of page paths.
   * One redirect fixes all three: 301 for `GET` and `HEAD`, 308 for other methods. Local names, IP addresses, and
   * preview hosts such as `*.workers.dev` keep their host and scheme. `vite dev` never redirects. On Cloudflare, static
   * files run the Worker first so they redirect too. Redirect moved pages with Nitro `routeRules`. Default: off.
   */
  redirects?: RedirectsOptions
  /**
   * Trust the `X-Forwarded-Proto` header of a proxy that ends TLS, such as Caddy or nginx. When its first value is
   * `https` and the server sees `http:`, the request URL becomes `https:` before any middleware or route runs, so URLs
   * built from the request start with `https://`. It never reads `X-Forwarded-Host`. Turn it on only when a proxy that
   * you run sets the header. Default: `false`.
   */
  trustProxy?: boolean
  /**
   * Refuse browser writes from other origins that carry cookies, with 403, before any middleware or route runs. A
   * request is refused when its method is not GET, HEAD, or OPTIONS, it has a `Cookie` header, and its
   * `Sec-Fetch-Site` is `same-site` or `cross-site`, or its `Origin` is not the app's origin. Requests without cookies,
   * such as bearer-token clients and webhooks, pass. `exclude` lists path prefixes that take writes from other sites.
   * Default: `false`.
   */
  sameOriginWrites?: boolean | SameOriginWritesOptions
  /**
   * Response headers and a request body limit for every route. By default, built output sends
   * `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, and
   * `Referrer-Policy: strict-origin-when-cross-origin` on each response that does not set them itself, and on static
   * files on Cloudflare, Netlify, and Vercel. `{ headers: false }` turns them off. `{ maxBodySize: "1mb" }` answers 413
   * to a larger request body. It adds no Content Security Policy.
   */
  security?: SecurityOptions
  agent?: boolean | AgentOptions
  auth?: boolean | AuthOptions
  blob?: boolean | BlobOptions
  browser?: boolean | BrowserOptions
  /**
   * Storage for Nitro's `cache` mount, which `defineCachedFunction()` and `defineCachedEventHandler()` use.
   * `true` selects the host's store: Workers KV binding `CACHE`, Vercel Runtime Cache, Deno KV, or `.vitehub/data/cache` on Node.
   * Development uses `.vitehub/data/cache`.
   * `{ driver: "kv" }` stores the cache in the app's default KV store under the `nitro-cache:` prefix, in development too. It requires `kv`.
   */
  cache?: boolean | CacheOptions
  channels?: boolean | ChannelsOptions
  /** Options for the `node` host. Other hosts ignore them. */
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
  /**
   * Writes a bundle report of each production build to `.vitehub/bundle/`: client and server size, the code that loads
   * at startup, and why each package is there. Read it with `vitehub bundle`. Off by default.
   */
  bundle?: boolean
  /** Drizzle Databases in `server/databases/`. Without a Database Definition, an enabled database is one empty default Database. */
  database?: boolean | DatabaseOptions
  /**
   * Stored reads in Nuxt, when the app installs `@vite-hub/device`. A client plugin opens the device: after hydration on
   * a page that the server rendered, else before the app mounts. With Auth, it names the account of `useUserSession()`
   * and waits for the copies to go on `signOut()`. `useStoredData`, `useStoredFetch`, `setDeviceAccount`, `clearDevice`,
   * and `inspectDevice` are auto-imported. `version` deletes the copies of another version. `account: false` leaves the
   * account to the app. `false` turns it off. A Vite app calls `openDevice()` itself.
   */
  device?: false | ViteHubDeviceOptions
  email?: boolean | EmailOptions
  /**
   * Public Env, Server Env, and build-time replacements in `public`, `server`, and `define`, with the options that resolve
   * them. On by default. `false` turns Env off.
   */
  env?: false | EnvOptions
  /**
   * A health route for load balancers and container health checks, at `/_vitehub/health` unless `route` moves it.
   * It answers `{ ok, version, commit, vitehub }` and checks each Database, KV store, and Blob store of the app in `checks`. It
   * answers 503 when one fails, and never shows error text.
   */
  health?: boolean | HealthOptions
  /**
   * What `vitehub deploy` does after it uploads the build: `check` lists paths that must answer with a 2xx status on
   * the deployed URL, and `indexNow: true` sends the sitemap URLs to IndexNow after a production deploy. With `health`,
   * the health route is checked too.
   */
  deploy?: DeployOptions
  kv?: boolean | KVOptions
  /**
   * The app MCP server at `/mcp`, with one tool per file in `server/mcp/tools/`. MCP clients sign in with `mcpOAuth()`
   * from `vite-hub/auth/mcp`, so it needs `auth`, unless `mcp: { auth: false }` lets anyone call every tool. Needs
   * `@vite-hub/mcp`.
   */
  mcp?: boolean | McpOptions
  /**
   * Request logs through Evlog, the logs that the Console and `vitehub logs` read with `logs`, and, with `service`, Agent
   * telemetry and papercut reports through `useObservability()`.
   */
  observability?: boolean | ObservabilityOptions
  /**
   * Queue Definitions in `server/queues/`. On Node, `true` uses Postgres with a Postgres Default Database, else local
   * files. An object sets Queue options, such as `cache`, or selects the Node driver with `driver`.
   */
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
   * A systemd unit for the server, written to `.output/<name>.service` by production builds on the `node` host. On by
   * default. It starts `node .output/server/index.mjs` in the project root, reads `.env` when it exists, and waits for the
   * Agent drain budget plus 30 seconds on stop. An object sets the name, user, directory, and environment. `false` writes
   * no unit. Other hosts ignore it.
   */
  systemd?: boolean | SystemdOptions
  /** Cloudflare Worker build options. */
  cloudflare?: CloudflareOptions
  /**
   * A Dockerfile for the server, written to `.output/Dockerfile` by production builds on the `node` host. On by default.
   * Build the image with `docker build -t <name> .output`. It runs `node .output/server/index.mjs` as the `node` user in
   * `/app`, mounts volumes for `/app/.vitehub` and a separate `dataDir`, stops on SIGTERM, and checks the `health`
   * route over HTTP when it is on. With native packages, build the app in the same Linux Node image that will run it.
   * `false` writes no Dockerfile. Other hosts ignore it.
   */
  docker?: boolean
  /**
   * Sandbox Tasks in `server/sandbox-tasks/` and `*.sandbox-task.ts` files. Each run starts an isolated Cloudflare or
   * Vercel Sandbox. `true` uses the Sandbox of the host. An object sets the driver options, such as
   * `{ driver: "cloudflare", keepAlive: true, migrationTag: "v2" }` or `{ driver: "vercel", networkPolicy: "deny-all" }`.
   * `driver: "vercel"` also works on hosts without a Sandbox, such as `node`, with Vercel credentials.
   */
  sandboxTask?: boolean | ViteHubSandboxTaskOptions
  schedule?: boolean | ScheduleOptions
  /**
   * Search engine files. `seo: { sitemap: true }` serves `/sitemap.xml` with the Nuxt pages without a dynamic part, the
   * static prerender routes, the published Content pages with a URL, and the entries of `server/sitemap.ts`, and
   * `/robots.txt` that names it unless the app has its own. URLs start with `publicUrl`, else the request origin.
   */
  seo?: SeoOptions
  workflow?: boolean | WorkflowOptions
  workspace?: boolean | WorkspaceOptions
}

/** Queue options accepted by the framework distribution. */
export type ViteHubQueueOptions = QueueOptions

/** Sandbox Task options accepted by the framework distribution: the options of `hubSandboxTask()`. */
export type ViteHubSandboxTaskOptions = Exclude<SandboxTaskOptions, false>

/**
 * The Sandbox driver of the app, or undefined when Sandbox Tasks are off or the host has no Sandbox. An explicit
 * `driver` wins over the host's Sandbox. Cloudflare Sandbox needs the Cloudflare host for its Container binding.
 */
export function resolveSandboxTaskDriver(sandboxTask: ViteHubOptions["sandboxTask"], plan: DeploymentPlan): "cloudflare" | "vercel" | undefined {
  if (!sandboxTask) return
  const driver = sandboxTask === true ? undefined : sandboxTask.driver
  if (driver === "cloudflare" && plan.host !== "cloudflare") {
    throw viteHubErrorDiagnostics.VITE_HUB_SANDBOX_DRIVER_HOST_UNSUPPORTED({ message: `[vitehub] sandboxTask.driver "cloudflare" works with the "cloudflare" host only, because Cloudflare Sandbox needs the Container and Durable Object binding of a Worker. The "${plan.host}" host cannot provide them.` })
  }
  if (driver) return driver
  return plan.services.sandbox.supported ? plan.services.sandbox.driver : undefined
}

/** The local and Postgres drivers run only on the Node host. */
function assertNodeQueueDriver(queue: ViteHubOptions["queue"], host: ViteHubHost): void {
  const driver = queue && queue !== true ? queue.driver : undefined
  if ((driver === "local" || driver === "postgres") && host !== "node") {
    throw viteHubErrorDiagnostics.VITE_HUB_R0141({ message: `[vitehub] queue.driver "${driver}" works with the "node" host only. The "${host}" host uses its own Queue. Remove queue.driver, or use the "node" host.` })
  }
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

/** The host variable names of each env-backed Server Env declaration, for `deployment.json`. Never values. */
function deploymentEnvEntries(registry: EnvRuntimeRegistry): DeploymentEnvEntry[] {
  return describeServerEnv(registry).entries.flatMap(entry => entry.source === "env" && entry.names
    ? [{ ...(entry.path ? { path: entry.path } : {}), names: entry.names, required: entry.required, secret: entry.secret, hasDefault: entry.hasDefault }]
    : [])
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
  isDeployCommandOwned: () => boolean,
  resolvedBuildConfig: () => ResolvedBuildConfig,
  systemd: { drainMs: number, name: string, options: SystemdOptions } | undefined,
  docker: DockerfileBuild | undefined,
  envPlugin: () => EnvVitePlugin | undefined,
  contributedEnv: () => readonly DeploymentEnvEntry[],
  envDir: () => string | false | undefined,
  deploy: DeploymentDeployManifest | undefined,
  cloudflareVars: () => ReturnType<typeof cloudflareServerEnvVars>,
) {
  return (nitro: {
    hooks: {
      hook: ((name: "compiled", callback: () => Promise<void>) => void)
        & ((name: "build:config", callback: (nitro: unknown, config: { rolldown?: BundlerConfig, rollup?: BundlerConfig }) => void) => void)
    }
    logger: { warn(message: string): void }
    options: { cloudflare?: { deployConfig?: boolean }, commands: Record<string, unknown>, output: { dir: string, serverDir: string }, preset?: string, rootDir: string }
  }) => {
    if (hostFromNitroPreset(nitro.options.preset) !== plan.host) return
    if (plan.host === "cloudflare" && nitro.options.cloudflare?.deployConfig !== false && !isDeployCommandOwned()) {
      // Nitro's `--cwd ./` relies on the `.wrangler/deploy` redirect in the project root, which a copied output lacks and a parent Wrangler config breaks.
      // `--cwd` into the server directory fails once that redirect exists, so name the config file.
      // Remove when Nitro fixes its deploy command (https://github.com/nitrojs/nitro/issues/5147).
      const config = outputRelativeArgument(nitro.options.output.dir, join(nitro.options.output.serverDir, "wrangler.json"))
      nitro.options.commands.deploy = `npx wrangler deploy --config ${config}${sandboxTaskRequested ? " --containers-rollout=gradual" : ""}`
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
      if (plan.host === "cloudflare") {
        await addCloudflareVars(nitro.options.output.serverDir, cloudflareVars())
        await collapseWranglerConfigFile(nitro.options.output.serverDir)
      }
      if (plan.output.packaging === "deno-node-modules") {
        invariant(serverPackages, "denoServerPackagesPlugin() sets the runtime packages when it writes the Deno server bundle")
        await finalizeDenoDeploymentOutput({ deploymentName: identity.name, outputDir, rootDir, serverPackages, ...resolvedBuildConfig() })
      }
      const registry = envPlugin()?.api.getServerEnvRegistry()
      const env = mergeDeploymentEnv([...registry ? deploymentEnvEntries(registry) : [], ...contributedEnv()])
      await finalizeDeploymentPlanOutput({ ...(registry || env.length ? { env } : {}), ...(deploy ? { deploy } : {}), envDir: envDir(), identity, outputDir, plan, rootDir, services })
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
      if (docker) await writeDockerfile(docker, { logger: nitro.logger, outputDir, serverDir: nitro.options.output.serverDir })
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

/**
 * A Node server has no host cron, so its Schedules run in the Process Runtime unless the app sets `runtime` or chooses
 * another `providerOutput` itself.
 */
function scheduleOptionsForHost(host: DeploymentPlan["host"], schedule: true | ScheduleOptions): ScheduleOptions {
  const options = schedule === true ? {} : schedule
  if (host !== "node" || options.runtime !== undefined || (options.providerOutput ?? "auto") !== "auto") return options
  return { ...options, runtime: { driver: "process" } }
}

/** `nitro` and `standalone` hand the wake to the host cron, which a Node server does not have. */
function assertNodeScheduleWake(schedule: ViteHubOptions["schedule"]): void {
  if (!schedule || schedule === true) return
  if (schedule.providerOutput !== "nitro" && schedule.providerOutput !== "standalone") return
  throw viteHubErrorDiagnostics.VITE_HUB_R0137({ message: `[vitehub] schedule.providerOutput "${schedule.providerOutput}" writes host cron output, but the "node" host has no cron, so this build would never run its Schedules. Remove providerOutput to run them in the server process, or set providerOutput: false to wake them yourself.` })
}

/**
 * Rejects the former `provider` key of the features whose driver `vitehub()` picks from the host. The host checks run
 * before the owner packages read their options, so without this check a host that has no such service would stop with
 * a host error, and a host that has one would hide the old key.
 */
function assertNoProviderKey(options: ViteHubOptions): void {
  for (const key of ["queue", "rateLimit", "sandboxTask"] as const) {
    const feature: unknown = options[key]
    if (!feature || typeof feature !== "object" || Reflect.get(feature, "driver") !== undefined || !Object.hasOwn(feature, "provider")) continue
    const provider: unknown = Reflect.get(feature, "provider")
    throw viteHubErrorDiagnostics.VITE_HUB_RENAMED_PROVIDER_KEY({ key, value: JSON.stringify(provider) ?? String(provider) })
  }
}

/**
 * The Rate Limit driver of a build. On Node, Rate Limit counts in KV when the app enables KV, because KV can use Redis
 * or a Postgres Database that every instance shares. When ViteHub selects `kv` itself, a store that cannot share counts
 * falls back to memory with a warning. An explicit `driver: "kv"` on such a store fails the build.
 */
function buildRateLimitDriver(plan: DeploymentPlan, options: ViteHubOptions): { driver: "cloudflare" | "kv" | "memory", memoryFallback?: true } {
  const configured = options.rateLimit && options.rateLimit !== true ? options.rateLimit.driver : undefined
  // Only Node has a KV store with a shared atomic increment that ViteHub selects. Cloudflare KV has none.
  if (configured === "kv" && plan.host !== "node") {
    throw viteHubErrorDiagnostics.VITE_HUB_R0144({ message: `[vitehub] rateLimit.driver "kv" works with the "node" host only. The "${plan.host}" host uses its own Rate Limit. Remove rateLimit.driver, or use the "node" host.` })
  }
  // An app that sets the driver chooses it itself, also when the host has another one.
  const explicit = explicitRateLimitDriver(options.rateLimit)
  if (explicit) return { driver: explicit }
  const policy = plan.services.rateLimit
  if (!policy.supported) return { driver: "memory" }
  if (plan.host !== "node") return { driver: policy.driver }
  if (configured === "kv") return { driver: configured }
  const kvEnabled = options.kv || (options.cache && options.cache !== true && options.cache.driver === "kv")
  return kvEnabled ? { driver: "kv", memoryFallback: true } : { driver: "memory" }
}

function deploymentPlugins(
  plan: DeploymentPlan,
  requestedServices: HostSelectedService[],
  blobEnabled: boolean,
  services: DeploymentServicesManifest,
  options: ViteHubOptions,
  envPlugin: EnvVitePlugin | undefined,
): Plugin[] {
  let deployCommandOwned = false
  let providerConflictWarned = false
  const resolvedBuildConfigs = new WeakMap<object, { current: ResolvedBuildConfig }>()
  let providerOutput: ReturnType<typeof useProviderOutputCatalog> | undefined
  let deploymentRoot: string | undefined
  let deploymentOutputDir: string | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  const deploymentEnvPlugin = { current: envPlugin }
  let resolvedPlugins: readonly unknown[] | undefined
  // Vite's resolved envDir, for `deployment.json`. The CLI reads the stage env files there.
  let resolvedEnvDir: string | false | undefined
  // The names that primitives read outside Server Env, for `deployment.json`. The Console belongs to this package.
  const contributedEnv = () => [
    ...collectDeploymentEnv(resolvedPlugins, { host: plan.host }),
    ...consoleDeploymentEnv(resolveConsoleOptions(options.console)),
  ]
  const subscribedEnvPlugins = new WeakSet<EnvVitePlugin>()
  const subscribeEnvPlugin = (plugin: EnvVitePlugin): void => {
    deploymentEnvPlugin.current = plugin
    if (subscribedEnvPlugins.has(plugin) || plan.host !== "cloudflare") return
    subscribedEnvPlugins.add(plugin)
    plugin.api.onServerEnvRegistry((registry: EnvRuntimeRegistry, config: UserConfig) => {
      if (getDeploymentHost(config) !== plan.host) return
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
  const nitroPreset = plan.host === "deno" ? "deno-server" : plan.nitroPreset
  return [
    {
      name: "vite-hub/deployment-settings",
      enforce: "pre",
      configEnvironment: { order: "post", handler: workerdDependencyConfig },
      config: {
        order: "pre",
        handler(config, environment) {
          Reflect.set(config, VITEHUB_DEPLOYMENT_HOST, plan.host)
          // Owners such as KV need the host before their early config hooks run.
          // Resource names wait until ordinary plugins have configured the root.
          const nitro = cloneRecord((config as { nitro?: unknown }).nitro)
          if (environment.command === "build" && nitro.preset === undefined) nitro.preset = nitroPreset
          if (environment.command === "build" && plan.host === "cloudflare") nitro.exportConditions = cloudflareExportConditions(nitro.exportConditions)
          ;(config as { nitro?: unknown }).nitro = nitro
        },
      },
    },
    {
      name: "vite-hub/deployment-host",
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
          if (isProductionBuild(config, environment)) assertEmailBuildDriver(plan.host, options.email)
          Reflect.set(config, VITEHUB_DEPLOYMENT_HOST, plan.host)
          for (const service of requestedServices) assertHostService(plan, service)
          // The dev server keeps manual runs working without a wake owner.
          if (building && plan.host === "node") assertNodeScheduleWake(options.schedule)
          const identity = resolveDeploymentIdentity(
            typeof config.root === "string" ? config.root : undefined,
            options.name,
            plan.host === "cloudflare" ? process.env.WRANGLER_CI_OVERRIDE_NAME : undefined,
          )
          const name = identity.name
          if (requestedServices.includes("queue") && plan.services.queue.supported) {
            const configuredQueue = options.queue && options.queue !== true ? options.queue : undefined
            // Queue infers the Node driver from the resolved Default Database.
            const driver = configuredQueue?.driver ?? (plan.host === "node" ? undefined : plan.services.queue.driver)
            const namePrefix = configuredQueue && "namePrefix" in configuredQueue ? configuredQueue.namePrefix : undefined
            setResolvedFeatureOptions(config, "queue", {
              ...configuredQueue,
              driver,
              ...(driver === "cloudflare" && namePrefix === undefined ? { namePrefix: `${name}-` } : {}),
            })
          }
          const rateLimitOptions = cloneRecord(options.rateLimit === true ? undefined : options.rateLimit)
          const rateLimitDriver = explicitRateLimitDriver(rateLimitOptions)
          if (options.rateLimit && (rateLimitDriver || plan.services.rateLimit.supported)) {
            setResolvedFeatureOptions(config, "rateLimit", {
              ...rateLimitOptions,
              namespace: name,
              // Cloudflare Rate Limit bindings exist only in the built wrangler.json, so the dev server keeps the owner
              // default for `serve`: one in-memory limiter.
              ...building ? buildRateLimitDriver(plan, options) : { driver: "memory" },
            })
          }
          if (requestedServices.includes("sandbox") && plan.services.sandbox.supported) {
            const configuredSandboxTask = options.sandboxTask && options.sandboxTask !== true ? options.sandboxTask : undefined
            const configuredSandboxName = configuredSandboxTask && "name" in configuredSandboxTask ? configuredSandboxTask.name : undefined
            setResolvedFeatureOptions(config, "sandboxTask", {
              ...configuredSandboxTask,
              ...(plan.services.sandbox.driver === "cloudflare" && configuredSandboxName === undefined
                ? { name: cloudflareResourceScope(name) + "-sandbox" }
                : {}),
              driver: plan.services.sandbox.driver,
            })
          }
          let nitro = cloneRecord((config as { nitro?: unknown }).nitro)
          if (blobEnabled && plan.services.blob.supported && plan.services.blob.driver === "cloudflare") {
            const optionBlob = options.blob === true ? undefined : options.blob
            if (!hasExplicitBlobStore(optionBlob)) {
              setResolvedFeatureOptions(config, "blob", hostBlobOptions(plan, cloneRecord(optionBlob), cloudflareR2BucketName(name)))
            }
          }
          if (plan.host === "cloudflare") {
            const wasm = cloneRecord(nitro.wasm)
            if (wasm.lazy === undefined) wasm.lazy = true
            nitro.wasm = wasm
            // workerd reads every export of the Worker entry as a handler and refuses to start on a shared value, such as
            // a number that another chunk imports from the entry. Keep shared values in internal chunks.
            const rollupConfig = cloneRecord(nitro.rollupConfig)
            if (rollupConfig.preserveEntrySignatures === undefined) nitro.rollupConfig = { ...rollupConfig, preserveEntrySignatures: "strict" }
            const cloudflare = cloneRecord(nitro.cloudflare)
            const wrangler = cloneRecord(cloudflare.wrangler)
            if (typeof wrangler.name !== "string") wrangler.name = cloudflareResourceScope(name)
            // Nitro reads the project wrangler file from its root, which is the Vite root. Its keys lose to this config.
            const project = readProjectWranglerConfig(resolve(config.root ?? process.cwd()))
            // Workers keep no logs without `observability`. An explicit value in either config wins, also `enabled: false`.
            if (wrangler.observability === undefined && project?.observability === undefined) wrangler.observability = { enabled: true }
            if (building && typeof options.publicUrl === "string") {
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
          const configuredHosting = process.env.VITEHUB_HOST
          if (configuredHosting && hostFromNitroPreset(configuredHosting) !== plan.host) {
            throw viteHubErrorDiagnostics.VITE_HUB_R0080({ message: "[vitehub] vitehub host " + JSON.stringify(plan.host) + " conflicts with VITEHUB_HOST=" + JSON.stringify(configuredHosting) + "." })
          }
          const providerConflict = findProviderHostConflict(plan.host)
          if (providerConflict) {
            const diagnostic = viteHubErrorDiagnostics.VITE_HUB_HOST_PROVIDER_CONFLICT({ detected: providerConflict.host, host: plan.host, variable: providerConflict.variable })
            // A production build for the wrong host deploys output that the provider cannot run.
            if (building) throw diagnostic
            if (!providerConflictWarned) console.warn(formatDiagnostic(diagnostic))
            providerConflictWarned = true
          }
          if (building) {
            if (configuredPreset && normalizeNitroPreset(configuredPreset) !== nitroPreset) {
              throw viteHubErrorDiagnostics.VITE_HUB_R0081({ message: "[vitehub] vitehub host " + JSON.stringify(plan.host) + " conflicts with nitro.preset " + JSON.stringify(configuredPreset) + "." })
            }
            for (const name of ["NITRO_PRESET", "SERVER_PRESET"] as const) {
              const value = process.env[name]
              if (value && normalizeNitroPreset(value) !== nitroPreset) {
                throw viteHubErrorDiagnostics.VITE_HUB_R0082({ message: "[vitehub] vitehub host " + JSON.stringify(plan.host) + " conflicts with " + name + "=" + JSON.stringify(value) + "." })
              }
            }
            const buildConfigRef: { current: ResolvedBuildConfig } = {
              current: {
                alias: [],
                conditions: [],
                define: {},
                extensions: [],
                // Nuxt does not run the deployment output plugin's configResolved hook, so read the plugins here.
                hasScheduleIntegration: (config.plugins as readonly unknown[] | undefined)?.flat(Infinity)
                  .some(plugin => isRecord(plugin) && plugin.name === "@vite-hub/schedule/vite") ?? false,
                mainFields: [],
                preserveSymlinks: false,
              },
            }
            const systemdOptions = options.systemd === true || options.systemd === undefined ? {} : options.systemd || undefined
            const systemd = plan.host === "node" && systemdOptions
              ? { drainMs: agentDrainMs(options.agent), name: systemdUnitName(systemdOptions, name), options: systemdOptions }
              : undefined
            const docker = plan.host === "node" && options.docker !== false
              ? {
                  ...(options.dataDir ? { dataDir: options.dataDir } : {}),
                  drainMs: agentDrainMs(options.agent),
                  ...(options.health ? { healthRoute: options.health === true ? defaultHealthRoute : options.health.route ?? defaultHealthRoute } : {}),
                  name,
                }
              : undefined
            const viteRoot = resolve(config.root ?? process.cwd())
            const cloudflareVars = () => {
              const envPlugin = deploymentEnvPlugin.current
              if (plan.host !== "cloudflare" || !options.cloudflare?.vars || !envPlugin) return []
              // Read the build environment the way the Env plugin does, so `.env.development` never applies.
              const buildEnv = { ...loadAllEnv(loadEnv, environment.mode, envPlugin.api.resolveProjectRoot(viteRoot)), ...process.env }
              return cloudflareServerEnvVars(envPlugin.api.getServerEnvRegistry(), buildEnv)
            }
            const deploy = resolveDeployManifest({ deploy: options.deploy, health: options.health, publicUrl: typeof options.publicUrl === "string" ? normalizePublicUrl(options.publicUrl) : undefined })
            if (deploy?.indexNow) {
              // The key file is a static file at the site root, such as `/3f2a....txt`.
              const dir = writeIndexNowKeyFile(resolveViteHubGeneratedRoot(config), deploy.indexNow.key)
              const publicAssets = Array.isArray(nitro.publicAssets) ? nitro.publicAssets : []
              nitro.publicAssets = [...publicAssets.filter(asset => cloneRecord(asset).dir !== dir), { baseURL: "/", dir, maxAge: 3600 }]
            }
            const module = deploymentNitroModule(plan, services, identity, requestedServices.includes("sandbox"), () => deployCommandOwned, () => buildConfigRef.current, systemd, docker, () => deploymentEnvPlugin.current, contributedEnv, () => resolvedEnvDir, deploy, cloudflareVars)
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
          if (plan.host === "cloudflare") {
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
            const cacheStorage = resolveCacheStorage(options.cache, plan.host, options.kv ? requireOptionalOwner(ownerModules.kvVite, "kv").kvStorageDriver : undefined)
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
        // Nuxt replays config for separate Nitro builds without running Vite configResolved.
        if ((config as { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean })[VITEHUB_NITRO_CONFIG_CONTEXT] === true) {
          // Widen first: flattening Vite's recursive PluginOption type is too deep for TypeScript.
          const plugins: readonly unknown[] | undefined = config.plugins
          resolvedPlugins = plugins?.flat(Infinity)
        }
        deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
        if (deploymentEnvPlugin.current) subscribeEnvPlugin(deploymentEnvPlugin.current)
        if (plan.host !== "cloudflare") return
        if ((config as { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean })[VITEHUB_NITRO_CONFIG_CONTEXT] === true) {
          const viteConfig = config as { nitro?: unknown }
          viteConfig.nitro = composeNitroCloudflareProviderOutput(useProviderOutputCatalog(config), viteConfig.nitro)
        }
      },
      configResolved(config) {
        resolvedPlugins = config.plugins
        resolvedEnvDir = config.envDir
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
        if (plan.host === "cloudflare") {
          deploymentEnvPlugin.current ??= findEnvPlugin(config.plugins)
          if (deploymentEnvPlugin.current) subscribeEnvPlugin(deploymentEnvPlugin.current)
          const viteConfig = config as typeof config & { nitro?: unknown }
          viteConfig.nitro = composeNitroCloudflareProviderOutput(useProviderOutputCatalog(config), viteConfig.nitro)
        }
        const nitro = cloneRecord((config as { nitro?: unknown }).nitro)
        deployCommandOwned = typeof cloneRecord(nitro.commands).deploy === "string"
        if (config.command === "build" && nitro.preset !== nitroPreset) {
          throw viteHubErrorDiagnostics.VITE_HUB_R0083({ message: "[vitehub] The " + JSON.stringify(plan.host) + " deployment plan requires Nitro preset " + JSON.stringify(nitroPreset) + "." })
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

/** The Rate Limit driver that the app sets, or `undefined` when ViteHub selects it from the host. */
function explicitRateLimitDriver(options: unknown): "cloudflare" | "memory" | undefined {
  const driver = cloneRecord(options).driver
  return driver === "cloudflare" || driver === "memory" ? driver : undefined
}

function hasExplicitBlobStore(options: boolean | BlobOptions | undefined): boolean {
  return Boolean(options && typeof options === "object" && ("driver" in options || "stores" in options))
}

const hostBlobConfigs = new WeakSet<object>()

function hostBlobOptions(
  plan: DeploymentPlan,
  options: boolean | BlobOptions | undefined,
  deploymentName = "vitehub-blob",
): BlobOptions {
  if (hasExplicitBlobStore(options)) return options as BlobOptions
  const configured = options && typeof options === "object" ? options : {}
  // NuxtHub's `S3_*` variables select a bucket before the host, so Blob infers the store from env.
  if (requireOptionalOwner(ownerModules.blobVite, "blob").hasS3BlobEnv(process.env)) return configured
  const fromHost = (blob: Exclude<BlobOptions, false>) => {
    hostBlobConfigs.add(blob)
    return blob
  }
  switch (plan.services.blob.supported && plan.services.blob.driver) {
    case "cloudflare": return fromHost({
      bucketName: process.env.BLOB_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET_NAME || process.env.R2_BUCKET_NAME || deploymentName,
      ...configured,
      driver: "cloudflare",
    })
    case "fs": return fromHost({ ...configured, driver: "fs" })
    case "netlify-blobs": return fromHost({ name: "vitehub-blob", ...configured, driver: "netlify-blobs" })
    case "vercel": return fromHost({ ...configured, driver: "vercel" })
    default: throw viteHubErrorDiagnostics.VITE_HUB_R0084({ message: "[vitehub] Missing Blob driver for deployment host " + JSON.stringify(plan.host) + "." })
  }
}

function normalizePublicUrl(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined
  // WHATWG URL parsing drops empty userinfo, so inspect the original authority
  // to reject credential syntax such as `https://@host` as well.
  const authority = value.trim().match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
  if (!url || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password || authority?.includes("@")) {
    throw viteHubErrorDiagnostics.VITE_HUB_PUBLIC_URL_INVALID({ value: JSON.stringify(value) })
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
  if (!options || typeof options !== "object") throw viteHubErrorDiagnostics.VITE_HUB_R0085({ message: "vitehub() requires an options object." })
  assertNoProviderKey(options)
  const host = resolveBuildHost(options.host)
  // Keep `false`: it turns the Console off, and unset keeps the development operation RPC.
  options = withConnectionsDatabase(withDataDir({ ...options, host, console: options.console === false ? false : resolveConsoleOptions(options.console) }))
  const configuredConsole = resolveConsoleOptions(options.console)
  const plan = resolveDeploymentPlan(host)
  // Cloudflare has no durable local filesystem. Treat the shorthand database
  // option as the host-native D1 driver so implicit databases (for example,
  // the one enabled by Connections) are provisioned and bound like explicit
  // D1 configurations.
  if (plan.host === "cloudflare" && options.database === true) options = { ...options, database: { driver: "cloudflare" } }
  if (options.agent && options.agent !== true && options.agent.runtime === "deno" && plan.host === "deno") {
    throw viteHubErrorDiagnostics.VITE_HUB_R0087({ message: "[vitehub] The \"deno\" host cannot deploy the Agent Deno runtime because its generated server is outside the deployed Nitro entrypoint. Use the host's Nitro runtime or compose an explicit Deno Agent deployment." })
  }
  const configuredAgent = options.agent && options.agent !== true ? options.agent : undefined
  const defaultInvocations = configuredAgent?.invocations
  if (options.agent && defaultInvocations !== false) {
    const store = typeof defaultInvocations === "object" ? defaultInvocations.store : defaultInvocations
    if (store === "database" && !options.database) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0131({ message: "[vitehub] agent.invocations \"database\" requires database. Set database in vitehub()." })
    }
    if (configuredAgent?.runtime === "deno" || plan.host === "netlify") {
      throw viteHubErrorDiagnostics.VITE_HUB_R0132({ message: "[vitehub] agent.invocations requires Nitro-hosted Agents. Netlify and Deno Agent output are not supported. Set agent.invocations to false and configure invocations on each Agent Definition." })
    }
  }
  assertFeatureSupported("browser", plan.host, options)
  const sandboxTaskDriver = resolveSandboxTaskDriver(options.sandboxTask, plan)
  const sandboxTaskEnabled = sandboxTaskDriver !== undefined
  const blobEnabled = Boolean(options.blob) && (plan.services.blob.supported || hasExplicitBlobStore(options.blob))
  const configuredQueue = options.queue && options.queue !== true ? options.queue : undefined
  assertNodeQueueDriver(options.queue, plan.host)
  const observability = options.observability === true ? {} : options.observability || undefined
  const { logs: logsOption, browserErrors, ...observabilityOptions } = observability ?? {}
  const observabilityLogs = logsOption === true ? {} : logsOption || undefined
  const telemetry = Boolean(observabilityOptions.service)
  const workflowEnabled = Boolean(options.workflow)
  // The packages of these features are optional peers. One error lists every package that the app must add, also the
  // SDKs that the host or a provider adds, such as `@vercel/functions` for Workflow on Vercel.
  const enabledFeatures = ([
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
    ["workflow", workflowEnabled],
    ["workspace", options.workspace],
  ] as const).filter(([, enabled]) => enabled).map(([feature]) => feature)
  assertFeaturePackages(enabledFeatures, hostFeaturePackages(enabledFeatures, plan.host, options))
  const { blobVite, browserVite, channelsVite, connectionsVite, emailVite, kvVite, markdownTemplateVite, queueVite, rateLimitVite, sandboxTaskVite, workflowVite } = ownerModules
  const configuredBlob = blobEnabled ? hostBlobOptions(plan, options.blob) : undefined
  const resolvedConsoleBlob = configuredBlob
    ? requireOptionalOwner(blobVite, "blob").resolveBlobViteConfig(configuredBlob, { hosting: plan.nitroPreset }).blob
    : false
  const blobStoreNames = resolvedConsoleBlob
    ? Object.keys(resolvedConsoleBlob.stores || { default: resolvedConsoleBlob.store })
    : []
  const consoleSections = resolveConsoleSectionIds({ ...options, env: options.env !== false, blob: blobEnabled, sandboxTask: sandboxTaskEnabled })
  // `.template.md` imports work when the app installed `@vite-hub/markdown-template`.
  const plugins: unknown[] = [doctorPlugin(), viteHubHintsPlugin(), ...markdownTemplateVite ? [markdownTemplateVite.hubMarkdownTemplate()] : []]
  const requestedServices: HostSelectedService[] = []
  if (options.blob !== undefined && options.blob !== false && !hasExplicitBlobStore(options.blob)) requestedServices.push("blob")
  if (options.queue) requestedServices.push("queue")
  // An app that sets `rateLimit.driver` chooses the driver itself, so the host does not need to provide one.
  if (options.rateLimit && !explicitRateLimitDriver(options.rateLimit)) requestedServices.push("rateLimit")
  // The host selects the Sandbox, unless an explicit driver is not the host's own, such as Vercel Sandbox on Node.
  const hostSandbox = plan.services.sandbox
  if (options.sandboxTask && (options.sandboxTask === true || !options.sandboxTask.driver || (hostSandbox.supported && options.sandboxTask.driver === hostSandbox.driver))) requestedServices.push("sandbox")
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
  plugins.push(vitestInlinePlugin())
  const providerImportAliases: Record<string, string> = {}
  const configuredKV = options.kv && options.kv !== true ? options.kv : undefined
  // hubKV() gets the preset only when `kv` is enabled; through the cache alone, it infers the host from env.
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
    for (const specifier of ["vite-hub/database", "@vite-hub/database", "@vite-hub/database/runtime/registry"]) {
      databaseRuntimeImports.set(specifier, specifier)
      // Vite applies the framework alias first, so resolveId can receive the facade path.
      const facade = frameworkProviderImportAliases[specifier]
      if (facade) databaseRuntimeImports.set(facade, specifier)
    }
    plugins.push(databaseDisabledPlugin(databaseRuntimeImports, options.database === false))
  }
  plugins.push(unavailableServicesPlugin(plan, { browser: Boolean(options.browser), realtime: Boolean(options.realtime) }))
  if (plan.host === "cloudflare") plugins.push(cloudflareShSyntaxPlugin(), cloudflarePkceChallengePlugin(), cloudflareRedirectsFileVitePlugin())
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
  if (browserErrors) plugins.push(browserErrorsVitePlugin())
  if (!evlogRegistered || observabilityOptions.evlog?.enabled === false) plugins.push(errorLogVitePlugin())
  const security = resolveSecurityPolicy(options.security)
  if (options.trustProxy || options.sameOriginWrites || security) plugins.push(requestPolicyVitePlugin(options, security))
  if (options.health) {
    const resolvedKV = options.kv && kvVite ? kvVite.resolveKVViteConfig(configuredKV, { hosting: kvHosting }).kv : false
    plugins.push(healthVitePlugin(options.health === true ? {} : options.health, {
      database: Boolean(options.database),
      kv: resolvedKV ? Object.keys(resolvedKV.stores || { default: resolvedKV.store }) : [],
      blob: blobStoreNames,
    }))
  }
  if (envPlugin) plugins.push(envPlugin)
  const redirects = resolveRedirectsPolicy(options.redirects)
  if (redirects) plugins.push(redirectsVitePlugin(redirects))
  plugins.push(staleChunkReloadVitePlugin())

  const runtimeCapabilityImports = {
    blob: blobEnabled ? "vite-hub/blob" : false,
    connections: options.connections ? generatedModules.connectionsAgent : false,
    console: configuredConsole ? "vite-hub/console/server" : false,
    db: options.database ? "@vite-hub/database/runtime/registry" : false,
    i18n: options.i18n ? "vite-hub/i18n/server" : false,
    // The `page()` Capability reaches the page through Realtime.
    realtime: options.realtime ? "vite-hub/realtime/agent" : false,
    // Email and KV capabilities exist only when the app installed their packages.
    ...emailVite ? { email: "vite-hub/email" } : {},
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
      name: options.name,
      contentImportBase: "vite-hub/content",
      blobStores: blobStoreNames,
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
    if (options.agent && !devOperationsOnly) plugins.push(consoleInvocationRootPlugin(invocationRootState))
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
    const sandboxTaskPluginOptions = {
      ...options.sandboxTask === true ? {} : options.sandboxTask,
      driver: sandboxTaskDriver,
      providerImportAliases,
      providerImportSpecifier: "vite-hub/sandbox/task",
    }
    // SAFETY: hubSandboxTask() removes the two package-private integration fields before it reads the public options.
    plugins.push(afterApplicationConfig(requireOptionalOwner(sandboxTaskVite, "sandboxTask").hubSandboxTask(sandboxTaskPluginOptions as SandboxTaskOptions)))
  }
  if (options.agent) {
    // The generated plugin installs the journal, with the Console on or off, so the Console only reads it.
    const { invocations: _invocations, ...agentOptions } = options.agent === true ? {} : options.agent
    if (defaultInvocations !== false || options.database) {
      plugins.push(agentInvocationsVitePlugin({
        database: Boolean(options.database),
        default: defaultInvocations,
        host: plan.host,
        resolveD1Binding: (root, serverDirs) => defaultDatabaseD1Binding(plan.host, options.database, { implicitDefault: true, root, serverDirs }),
        stateUrl: agentJournalStateUrl(options),
      }))
    }
    plugins.push(requireOptionalOwner(ownerModules.agentVite, "agent").hubAgent({
      ...agentOptions,
      kvImport: "vite-hub/kv",
      processDiscordGateway: plan.host === "node",
      providerImportAliases,
      runtimeCapabilityImports: {
        ...runtimeCapabilityImports,
        // Present only with the Auth plugin. It reads users only for Actors that authenticated() resolved.
        auth: "vite-hub/auth/agent",
      },
      workflowModules: workflowEnabled ? { index: "vite-hub/workflow", state: requireOptionalOwner(workflowVite, "workflow").workflowRuntimeModule("state") } : false,
      workspaceDependencyRuntimeImports,
    } as AgentPluginOptions))
  }
  if (options.browser) plugins.push(requireOptionalOwner(browserVite, "browser").hubBrowser(options.browser === true ? undefined : options.browser))
  if (options.channels) plugins.push(requireOptionalOwner(channelsVite, "channels").hubChannels(options.channels === true ? undefined : options.channels))
  if (options.connections) {
    const { database: databaseName, ...connections } = options.connections === true ? {} : options.connections
    const connectionsOptions: ConnectionsVitePluginOptions = { ...connections, database: "@vite-hub/database/runtime/registry", ...(databaseName !== undefined ? { databaseName } : {}), importBase: "vite-hub/connections" }
    plugins.push(requireOptionalOwner(connectionsVite, "connections").hubConnections(connectionsOptions))
  }
  else if (connectionsVite) plugins.push(connectionsVite.hubConnectionsTypesCleanup())
  if (options.database) plugins.push(requireOptionalOwner(ownerModules.databaseVite, "database").hubDatabase(options.database === true ? undefined : options.database))
  if (blobEnabled) {
    plugins.push(afterApplicationConfig(requireOptionalOwner(blobVite, "blob").hubBlob(configuredBlob, { importBase: "vite-hub/blob", presetDriver: blob => Boolean(blob && hostBlobConfigs.has(blob)) })))
  }
  if (options.email) {
    // `email: true` uses the host provider, or `log` in `vite dev` on a host without one.
    const emailOptions = options.email === true ? { driver: defaultEmailDriver(plan.host) } : options.email
    plugins.push(requireOptionalOwner(emailVite, "email").hubEmail({
      ...emailOptions,
      hosting: plan.nitroPreset,
      importBase: "vite-hub/email",
      runtimeEnvImport: envServerRuntimeImport,
      workflowDriver: options.workflow && options.workflow !== true ? options.workflow.driver : undefined,
    } as EmailOptions))
  }
  else if (emailVite) plugins.push(emailVite.hubEmailOptionalPeerResolver())
  // A KV cache also needs the owner plugin when no KV options were set.
  if (options.kv || (options.cache && options.cache !== true && options.cache.driver === "kv")) {
    // hubKV() infers the driver itself, because development keeps inferred stores local unless they set `remote: true`.
    plugins.push(requireOptionalOwner(kvVite, "kv").hubKV(configuredKV, { ...(kvHosting ? { hosting: kvHosting } : {}), databaseImport: "@vite-hub/database/runtime/registry" }))
  }
  else if (kvVite) plugins.push(kvVite.hubKVOptionalPeerResolver())
  if (options.queue && plan.services.queue.supported) {
    const driver = configuredQueue?.driver ?? (plan.host === "node" ? undefined : plan.services.queue.driver)
    // SAFETY: The driver is the host's Queue driver or the app's own `queue.driver`.
    plugins.push(afterApplicationConfig(requireOptionalOwner(queueVite, "queue").hubQueue({ ...configuredQueue, ...(driver ? { driver } : {}) } as QueueOptions, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })))
  }
  if (options.i18n) {
    // SAFETY: ViteHub adds the public import path of its re-exports to the public i18n options.
    plugins.push(requireOptionalOwner(ownerModules.i18nVite, "i18n").hubI18n({ ...options.i18n, importBase: "vite-hub/i18n" } as I18nOptions))
  }
  if (options.bundle) plugins.push(hubBundle())
  if (options.mcp) {
    const mcpConfig: McpOptions = options.mcp === true ? {} : options.mcp
    const { auth: mcpAuth = true, ...mcpOptions } = mcpConfig
    if (mcpAuth && !options.auth) {
      throw viteHubErrorDiagnostics.VITE_HUB_MCP_AUTH_MISSING()
    }
    plugins.push(requireOptionalOwner(ownerModules.mcpVite, "mcp").hubMcp({
      ...mcpOptions,
      auth: mcpAuth,
      imports: { authMcp: "vite-hub/auth/mcp", runtime: "@vite-hub/mcp/runtime" },
      ...(options.name ? { name: options.name } : {}),
    }))
  }
  if (options.rateLimit) {
    // SAFETY: ViteHub adds its KV re-export path to the public Rate Limit options for generated imports.
    plugins.push(afterApplicationConfig(requireOptionalOwner(rateLimitVite, "rateLimit").hubRateLimit({
      ...(options.rateLimit === true ? {} : options.rateLimit),
      ...buildRateLimitDriver(plan, options),
      kvImport: "vite-hub/kv",
    } as RateLimitOptions & { kvImport: string })))
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
    // Guest writes count in Rate Limit when its KV store is shared, as Forms messages do.
    rateLimit: Boolean(options.rateLimit) && buildRateLimitDriver(plan, options).driver === "kv",
    imports: {
      auth: generatedModules.commentsRuntimeAuth,
      blob: "vite-hub/blob",
      contentClient: "vite-hub/content/client",
      database: "vite-hub/comments/database",
      databases: "@vite-hub/database/runtime/registry",
      rateLimit: "vite-hub/rate-limit",
      realtime: generatedModules.commentsRealtime,
      runtime: "vite-hub/comments/runtime",
    },
  })
  if (options.realtime) {
    plugins.push(requireOptionalOwner(ownerModules.realtimeVite, "realtime").hubRealtime({
      // Rooms of this app stay apart from other apps on the same Redis or Postgres.
      ...(options.name ? { namespace: options.name } : {}),
      ...(options.realtime === true ? {} : options.realtime),
      // The Postgres bus borrows the client of a Postgres Default Database.
      databaseImport: "vite-hub/database/drizzle",
      importBase: "vite-hub/realtime",
      // Content edits Markdown documents live, and Comments shows who is on a page, where Realtime has a room authority.
      // Other hosts keep one Content editor at a time and show comments without presence. Agents get a room for each
      // page, which the `page()` Capability asks.
      contribute: async (context) => {
        const [content, comments, agentPages] = await Promise.all([
          ownerModules.contentVite?.contributeContentRealtime({
            ...context,
            contentImport: "vite-hub/content/realtime",
            realtimeImport: "vite-hub/realtime/server",
            ...(configuredConsole ? { console: { module: generatedModules.consoleSections, section: "content" } } : {}),
          }),
          commentsPlugin?.api.contributeRealtime(context),
          options.agent ? ownerModules.agentVite?.contributeAgentPageRealtime(context) : undefined,
        ])
        return {
          definitions: [...content?.definitions ?? [], ...comments?.definitions ?? [], ...agentPages?.definitions ?? []],
          plugins: content?.plugins ?? [],
        }
      },
    }))
  }
  if (options.schedule) {
    plugins.push(requireOptionalOwner(ownerModules.scheduleVite, "schedule").hubSchedule({
      // Vercel cron jobs and Deno.cron call entries outside the Nitro server.
      ...(plan.host === "vercel" || plan.host === "deno" ? { providerOutput: "standalone" as const } : {}),
      ...scheduleOptionsForHost(plan.host, options.schedule),
      databaseImport: "vite-hub/database",
      importBase: "vite-hub/schedule",
      providerImportAliases,
      requireKVPluginForProcessStores: true,
    } as ScheduleOptions))
  }
  if (workflowEnabled) {
    plugins.push(requireOptionalOwner(workflowVite, "workflow").hubWorkflow(
      options.workflow && options.workflow !== true ? options.workflow : {},
      {
      databaseImport: "vite-hub/database",
      hosting: plan.nitroPreset,
      importBase: "vite-hub/workflow",
      providerImportAliases,
      includeUserAppEntry: true,
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
  if (options.seo?.sitemap || options.seo?.robots) plugins.push(viteHubSeoPlugin(options.seo, typeof options.publicUrl === "string" ? normalizePublicUrl(options.publicUrl) : undefined))
  const sourcePlugin = hubSource({
    ...options.seo?.sitemap || options.seo?.robots ? { appSeo: { sitemap: Boolean(options.seo.sitemap), robots: options.seo.robots !== false } } : {},
    auth: options.auth
      ? ({ projectRoot, serverDirs }) => Boolean(requireOptionalOwner(ownerModules.authVite, "auth").resolveAuthViteConfig(
          options.auth === true ? undefined : options.auth,
          projectRoot,
          { serverDirs },
        ))
      : false,
    contentImportBase: "vite-hub/content",
    importBase: "vite-hub/source",
    // A `github()` Source prewarms the pages of each push through the `vitehub-content-prewarm` Queue.
    queue: Boolean(options.queue) && plan.services.queue.supported && plan.host !== "vercel",
    queueImport: "vite-hub/queue",
  })
  plugins.push(sourcePlugin)
  // Adds the `vitehub content` commands, the Content operations, and the Content inspector. Inert without server/content.ts.
  // The app installs only `vite-hub`, so the KV and snapshot registrations that it adds to server/content.ts import
  // `vite-hub/content` and `vite-hub/kv`. `kvImport` is an internal Content option.
  if (ownerModules.contentVite) {
    const contentOptions = { importBase: "vite-hub/content", kvImport: "vite-hub/kv" }
    plugins.push(ownerModules.contentVite.hubContent(contentOptions))
  }
  // Forms in `server/forms/<name>.ts`: one route for each, submissions in the Database, email with Email, the user
  // with Auth, and the message counts in Rate Limit when its KV store is shared. Inert without the folder, and absent
  // without its package.
  if (ownerModules.formsVite) plugins.push(ownerModules.formsVite.hubForms({
    database: Boolean(options.database),
    email: Boolean(options.email),
    auth: Boolean(options.auth),
    rateLimit: Boolean(options.rateLimit) && buildRateLimitDriver(plan, options).driver === "kv",
    imports: {
      runtime: "vite-hub/forms/runtime",
      operations: "vite-hub/forms/operations",
      database: "vite-hub/forms/database",
      databases: "@vite-hub/database/runtime/registry",
      email: "vite-hub/email",
      auth: "vite-hub/auth/server",
      standard: "vite-hub/runtime",
      rateLimit: "vite-hub/rate-limit",
    },
  }))
  // Sync in `server/sync/<name>.ts`: one route for each, the change log in the Database, and the user with Auth. Inert
  // without the folder, and absent without its package.
  if (ownerModules.syncVite) plugins.push(ownerModules.syncVite.hubSync({
    database: Boolean(options.database),
    auth: Boolean(options.auth),
    imports: {
      runtime: "vite-hub/sync/runtime",
      operations: "vite-hub/sync/operations",
      database: "vite-hub/sync/database",
      databases: "@vite-hub/database/runtime/registry",
      auth: "vite-hub/auth/server",
    },
  }))
  // Reads the `cms` preset and contributes its Workspace, Database tables, and, when the app has none, the default
  // Database. Inert without the preset.
  if (ownerModules.cmsVite) plugins.push(ownerModules.cmsVite.hubCms({
    imports: {
      blob: "vite-hub/blob",
      blobDatabase: "vite-hub/workspace/blob-database",
      contentDatabase: "vite-hub/content/database",
      database: "@vite-hub/database/runtime/registry",
      workspace: "vite-hub/workspace",
    },
  }))
  if (commentsPlugin) plugins.push(commentsPlugin)
  else if (options.comments === false) plugins.push(commentsOffPlugin())
  // Webhooks in `server/webhooks/<name>.ts`: deliveries in the Default Database, sent through the `vitehub-webhooks`
  // Queue that the plugin contributes. Inert without the folder, and absent without its package.
  if (ownerModules.webhooksVite) plugins.push(ownerModules.webhooksVite.hubWebhooks({
    database: Boolean(options.database),
    queue: Boolean(options.queue) && plan.services.queue.supported,
    imports: {
      runtime: "vite-hub/webhooks/runtime",
      operations: "vite-hub/webhooks/operations",
      database: "vite-hub/webhooks/database",
      databases: "@vite-hub/database/runtime/registry",
      queue: "vite-hub/queue",
      types: "vite-hub/webhooks",
    },
  }))
  if (!ownerModules.commentsVite || !ownerModules.contentVite || !ownerModules.cmsVite || !ownerModules.formsVite || !ownerModules.webhooksVite || !ownerModules.syncVite) plugins.push(optionalOwnerEntriesPlugin({ database: options.database !== false }))
  plugins.push(optionalOwnerImportsPlugin())
  // Nitro tasks in `server/tasks/`, listed and run with `vitehub task`.
  plugins.push(viteHubTaskPlugin())
  // `vitehub cache` and the Console Cache section read Nitro's `cache` mount.
  if (options.cache) plugins.push(viteHubCachePlugin())
  // The skills of `server/skills.ts`, listed and turned on and off with `vitehub served-skills` and the Console.
  plugins.push(viteHubServedSkillsPlugin())
  // A Node server prints where each primitive keeps its state, and fails at boot when several instances would split it.
  if (plan.host === "node") plugins.push(viteHubDurabilityPlugin(options.node))
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
  assertNoRemovedViteHubOptions(options, "`vitehub()`")
  // Wrap each plugin list before the CMS preset variants switch between them, so every selected variant prints.
  const create = (resolved: ViteHubOptions) => withCmsPresetPlugins(withComments(resolved), variant => withPrintedDiagnostics(createViteHubPlugins(variant)))
  // A framework integration that knows the project root, such as Nuxt, resolves the Definition features itself.
  if (featureOptionsResolved(options)) return create(options)
  const project = { projectRoot: resolveViteHubProjectRoot(process.cwd()) }
  try {
    const resolved = resolveDefinitionFeatures(options, project)
    if (resolved !== options) return [...create(resolved), definitionFeaturesRootPlugin(options, project)]
  }
  catch (error) {
    return [definitionFeaturesRootPlugin(options, project, () => { throw error })]
  }
  return [...create(options), definitionFeaturesRootPlugin(options, project)]
}
