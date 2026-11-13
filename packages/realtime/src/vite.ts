import { readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { VITEHUB_SERVER_DIRS, isProductionBuild, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider, resolveHost } from "@vite-hub/internal/hosting"
import { cloneRecord as record } from "@vite-hub/internal/object"

import { discoverRealtimeDefinitions } from "./discovery.ts"
export { discoverRealtimeDefinitions } from "./discovery.ts"
import { realtimeKeepalivePing, realtimeKeepalivePong } from "./protocol.ts"
import { summarizeRealtimeDefinitions } from "./inspect.ts"

import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ViteHubDefinitionSummary, ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, PluginOption, UserConfig } from "vite"
import type { RealtimeInspectionAuthority } from "./inspect.ts"
import type { DiscoveredRealtimeDefinition, RealtimeOptions } from "./types.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"
import unavailable from "./internal/runtime/unavailable.ts"

/** Where a contributed definition runs. */
export interface RealtimeContributionContext {
  /**
   * Where the rooms of this build live: Durable Objects (`cloudflare`), or the memory of each Node process (`memory`),
   * also when Node instances share rooms through Postgres or Redis. Contributions only run when there is one.
   */
  authority: "cloudflare" | "memory"
  /** `.vitehub/nitro/realtime`, for generated definition files. */
  directory: string
  projectRoot: string
  serverDirs?: string[]
}

/** Definitions and Nitro plugins that another package adds, such as Content live editing. */
export interface RealtimeContribution {
  /** Generated definition files. A file in `server/realtime/` with the same name wins. */
  definitions?: Array<Pick<DiscoveredRealtimeDefinition, "handler" | "name">>
  /** Nitro plugin files to install with the Realtime route. */
  plugins?: string[]
}

export interface RealtimeVitePluginOptions extends RealtimeOptions {
  /** Module that exports the app's `databases`, for the Postgres bus. Defaults to `@vite-hub/database/drizzle`. */
  databaseImport?: string
  importBase?: string
  /**
   * Adds definitions owned by another package. It runs only when the build has a room authority (Cloudflare Durable
   * Objects, a Node server, or memory in development). Without one, Realtime leaves the contribution out without an
   * error, so the contributing feature can fall back.
   */
  contribute?: (context: RealtimeContributionContext) => Promise<RealtimeContribution | undefined> | RealtimeContribution | undefined
}

export type RealtimeVitePlugin = Plugin & { vitehub: ViteHubInspectionPluginMetadata & DurabilityPluginMetadata }

export interface RealtimeInspectionOptions {
  /** Resolved room authority. Defaults to `auto`. */
  authority?: RealtimeInspectionAuthority
  projectRoot: string
  serverDirs?: string[]
  /** Definitions other packages contributed to this build, such as Content live editing. */
  contributed?: readonly DiscoveredRealtimeDefinition[]
}

/**
 * Lists Realtime Definitions with their document adapter, editor codec, identity, authorization,
 * persistence, and room authority, read statically from each definition file.
 */
export async function inspectRealtimeDefinitions(options: RealtimeInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  return await summarizeRealtimeDefinitions(
    options.projectRoot,
    [...discoverRealtimeDefinitions(options.projectRoot, options.serverDirs), ...options.contributed ?? []],
    options.authority ?? "auto",
  )
}

interface NitroConfig extends Record<string, unknown> {
  cloudflare?: Record<string, unknown>
  features?: Record<string, unknown>
  handlers?: Array<Record<string, unknown>>
  preset?: string
}

function configureCloudflareRealtime(nitro: NitroConfig): void {
  nitro.preset = "cloudflare-module"
  const cloudflare = record(nitro.cloudflare)
  const wrangler = record(cloudflare.wrangler)
  const durableObjects = record(wrangler.durable_objects)
  const bindings = Array.isArray(durableObjects.bindings) ? durableObjects.bindings : []
  if (!bindings.some(binding => record(binding).name === "$DurableObject")) {
    durableObjects.bindings = [...bindings, { class_name: "$DurableObject", name: "$DurableObject" }]
  }
  const migrations = Array.isArray(wrangler.migrations) ? wrangler.migrations : []
  if (!migrations.some(migration => record(migration).tag === "vitehub-realtime-v1")) {
    wrangler.migrations = [
      ...migrations,
      { new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" },
    ]
  }
  wrangler.durable_objects = durableObjects
  cloudflare.wrangler = wrangler
  nitro.cloudflare = cloudflare
}

/** Packages that share the Yjs runtime on the server. They must load as one module graph. */
const realtimeServerYjsPackages = ["yjs", "y-protocols", "lib0", "@tiptap/y-tiptap", /^y-protocols\//, /^lib0\//]

function moduleSpecifier(from: string, to: string): string {
  const value = relative(dirname(from), to).replaceAll("\\", "/")
  return value.startsWith(".") ? value : `./${value}`
}

function applicationBaseURL(base: string | undefined): string {
  return base?.startsWith("/") && !base.startsWith("//") ? base : "/"
}

const databaseVitePluginName = "@vite-hub/database/vite"

/** The part of the Database Vite plugin that Realtime reads: its resolved configuration. */
interface DatabaseVitePlugin {
  api?: { getConfig?: () => { databases: Record<string, { dialect?: string } | undefined> } | undefined }
}

function findDatabasePlugin(plugins: readonly PluginOption[] | undefined): DatabaseVitePlugin | undefined {
  for (const plugin of plugins ?? []) {
    if (Array.isArray(plugin)) {
      const found = findDatabasePlugin(plugin)
      if (found) return found
    }
    // SAFETY: The plugin name identifies the Database integration, whose `api` has this shape.
    else if (plugin && typeof plugin === "object" && "name" in plugin && plugin.name === databaseVitePluginName) return plugin as DatabaseVitePlugin
  }
  return undefined
}

/** Whether the Database integration resolved the Default Database on Postgres. The Postgres bus then uses its client. */
function hasPostgresDefaultDatabase(plugin: DatabaseVitePlugin | undefined): boolean {
  return plugin?.api?.getConfig?.()?.databases.default?.dialect === "postgresql"
}

type RealtimeNodeAuthority = "auto" | "postgres" | "redis"

/**
 * The handler and the Nitro plugin of a Node build. `database` is the module that exports the app's `databases`, when
 * the Default Database is on Postgres: the bus then borrows the postgres.js client of that Database.
 */
function renderNodeFiles(input: { busPlugin?: string, database?: string, handlerFile: string, importBase: string, namespace: string, nodeAuthority?: RealtimeNodeAuthority, registryFile: string }): Array<[string, string]> {
  const { busPlugin, database, handlerFile, importBase, namespace, nodeAuthority, registryFile } = input
  const busOptions = `, { ${database ? `databases: () => import(${JSON.stringify(database)}).then(module => module.databases), ` : ""}namespace: ${JSON.stringify(namespace)} }`
  const logOptions = `{ ${database ? "database: true, " : ""}namespace: ${JSON.stringify(namespace)} }`
  const handler = [
    `import registry from ${JSON.stringify(moduleSpecifier(handlerFile, registryFile))}`,
    `import { createRealtimeHandler } from ${JSON.stringify(`${importBase}/server`)}`,
    ...nodeAuthority
      ? [
          `import { useRealtimeBus } from ${JSON.stringify(`${importBase}/bus`)}`,
          "",
          "// Shares rooms with the other instances of this app. The server picks the bus when it starts.",
          `export default createRealtimeHandler(registry, { bus: () => useRealtimeBus(${JSON.stringify(nodeAuthority)}${busOptions}) })`,
        ]
      : ["", "export default createRealtimeHandler(registry)"],
    "",
  ].join("\n")
  if (!busPlugin || !nodeAuthority) return [[handlerFile, handler]]
  return [[handlerFile, handler], [busPlugin, [
    `import { closeRealtimeBuses, logRealtimeNodeAuthority } from ${JSON.stringify(`${importBase}/bus`)}`,
    "",
    "export default (nitroApp) => {",
    "  // Prints where the rooms of this server live.",
    `  logRealtimeNodeAuthority(${JSON.stringify(nodeAuthority)}, ${logOptions})`,
    "  // Removes this instance's presence from the other instances, and lets the process exit. A borrowed Database client stays open.",
    "  nitroApp.hooks.hook(\"close\", () => closeRealtimeBuses())",
    "}",
    "",
  ].join("\n")]]
}

/** The app name: the `name` in the root `package.json`, else the root folder name. */
function defaultNamespace(root: string): string {
  try {
    const name: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name
    if (typeof name === "string" && name.trim()) return name.trim()
  }
  catch {}
  return basename(root) || "default"
}

const realtimeAvailabilityId = "#vitehub/realtime/availability"
const resolvedRealtimeAvailabilityId = `\0${realtimeAvailabilityId}`

export function hubRealtime(options: RealtimeVitePluginOptions = {}): RealtimeVitePlugin {
  const importBase = options.importBase ?? "@vite-hub/realtime"
  let inspectionRoot: string | undefined
  let inspectionServerDirs: string[] | undefined
  let inspectionAuthority: RealtimeInspectionAuthority = options.authority ?? "auto"
  let inspectionContributed: DiscoveredRealtimeDefinition[] = []
  let hasRoomAuthority = false
  const databaseImport = options.databaseImport ?? "@vite-hub/database/drizzle"
  let databasePlugin: DatabaseVitePlugin | undefined
  // The Default Database is on Postgres. Read when the config is made, and again at `buildStart`.
  let postgresDatabase = false
  // The files of a Node build, to write again when the Default Database turns out to be on Postgres.
  let nodeWrite: { busPlugin?: string, handlerFile: string, namespace: string, nodeAuthority: RealtimeNodeAuthority, postgres: boolean, registryFile: string } | undefined
  return {
    name: "@vite-hub/realtime/vite",
    enforce: "pre",
    vitehub: {
      // Without a room authority the build fails or Realtime is unavailable, so there is no state to report.
      durability: () => hasRoomAuthority
        ? [{ export: "realtimeDurability", input: { authority: inspectionAuthority }, module: durabilityModuleFile(import.meta.url), primitive: "realtime" }]
        : [],
      inspect: () => ({
        definitions: [{
          kind: "realtime",
          label: "Realtime",
          list: () => inspectRealtimeDefinitions({
            authority: inspectionAuthority,
            projectRoot: inspectionRoot ?? resolveViteHubProjectRoot(process.cwd(), options),
            serverDirs: inspectionServerDirs,
            contributed: inspectionContributed,
          }),
        }],
      }),
    },
    async config(config, environment) {
      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), options)
      const serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      inspectionRoot = root
      inspectionServerDirs = serverDirs
      const discovered = discoverRealtimeDefinitions(root, serverDirs)
      // SAFETY: Vite's config contract exposes Nitro options through this optional property.
      const nitro = { ...(config as { nitro?: NitroConfig }).nitro }
      const host = resolveHost({ nitro })
      const provider = getHostingProvider(host)
      const authority = options.authority || "auto"
      const directory = resolve(root, ".vitehub/nitro/realtime")
      const build = isProductionBuild(config, environment)
      const node = !host || host === "node"
      // A Node build shares its rooms with the other instances through Postgres or Redis. `vite dev` keeps them in memory.
      const nodeAuthority = !build || !node ? undefined
        : authority === "postgres" || authority === "redis" ? authority
          : authority === "auto" && provider !== "cloudflare" ? "auto" as const : undefined
      // The authority a contribution may rely on. Configurations that fail below have none. Rooms on Node live in the
      // memory of each instance, also when they are shared.
      const available: RealtimeContributionContext["authority"] | undefined
        = authority === "cloudflare" ? (!host || host === "cloudflare" ? "cloudflare" : undefined)
          : authority === "auto" && provider === "cloudflare" ? "cloudflare"
            : authority !== "auto" ? (node ? "memory" : undefined)
              : !build || nodeAuthority ? "memory" : undefined
      hasRoomAuthority = Boolean(available)
      const contribution = available && options.contribute
        ? await options.contribute({ authority: available, directory, projectRoot: root, serverDirs })
        : undefined
      const definitions = [
        ...discovered,
        ...(contribution?.definitions ?? [])
          .filter(definition => !discovered.some(entry => entry.name === definition.name))
          .map((definition): DiscoveredRealtimeDefinition => ({ ...definition, source: "contributed" })),
      ]
      inspectionContributed = definitions.filter(definition => definition.source === "contributed")
      if (definitions.length === 0) return

      config.resolve = {
        ...config.resolve,
        dedupe: [...new Set([...(config.resolve?.dedupe || []), "yjs"])],
      }
      // The server must load one Yjs. In development Vite inlines `yjs` for Realtime when the app cannot resolve it,
      // while the Yjs packages that Realtime imports load it natively: two copies break Yjs constructor checks and
      // drop every client edit. Inline the Yjs family together in the Nitro environment.
      const environments = { ...(config as { environments?: Record<string, Record<string, unknown>> }).environments }
      const nitroEnvironment = { ...environments.nitro }
      const nitroResolve = { ...nitroEnvironment.resolve as Record<string, unknown> }
      const noExternal = nitroResolve.noExternal
      if (noExternal !== true) {
        nitroResolve.noExternal = [...(Array.isArray(noExternal) ? noExternal : noExternal ? [noExternal] : []), ...realtimeServerYjsPackages]
        nitroEnvironment.resolve = nitroResolve
        environments.nitro = nitroEnvironment
        ;(config as { environments?: Record<string, Record<string, unknown>> }).environments = environments
      }
      config.define = {
        __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(config.base)),
        ...config.define,
      }

      const registryFile = resolve(directory, "registry.mjs")
      const handlerFile = resolve(directory, "handler.ts")
      const busPlugin = nodeAuthority ? resolve(directory, "bus.mjs") : undefined
      databasePlugin = findDatabasePlugin(config.plugins) ?? databasePlugin
      postgresDatabase = !!nodeAuthority && hasPostgresDefaultDatabase(databasePlugin)
      const namespace = options.namespace?.trim() || defaultNamespace(root)
      const nodeFiles = (files: { busPlugin?: string, handlerFile: string, registryFile: string }) => renderNodeFiles({
        ...files,
        database: postgresDatabase ? databaseImport : undefined,
        importBase,
        namespace,
        nodeAuthority,
      })
      nodeWrite = nodeAuthority ? { busPlugin, handlerFile, namespace, nodeAuthority, postgres: postgresDatabase, registryFile } : undefined
      await mkdir(directory, { recursive: true })
      await Promise.all([
        writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
        ...nodeFiles({ busPlugin, handlerFile, registryFile }).map(([file, contents]) => writeFile(file, contents)),
      ])

      if (authority === "cloudflare" && host && host !== "cloudflare") {
        throw realtimeErrorDiagnostics.REALTIME_AUTHORITY_CONFLICT({ authority: "cloudflare", host })
      }
      let durablePlugin: string | undefined
      if (authority === "cloudflare" || (authority === "auto" && provider === "cloudflare")) {
        inspectionAuthority = "cloudflare"
        configureCloudflareRealtime(nitro)
        // The plugin does not import the Realtime server (Tiptap, ProseMirror, Yjs), so a cold start does not load it.
        durablePlugin = resolve(directory, "durable-object.mjs")
        await writeFile(durablePlugin, [
          "export default (nitroApp) => {",
          "  nitroApp.hooks.hook(\"cloudflare:durable:init\", (_durable, { state }) => {",
          "    // Answer the clients' keepalive without waking the Durable Object from hibernation.",
          `    if (typeof WebSocketRequestResponsePair === "function") state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(${JSON.stringify(realtimeKeepalivePing)}, ${JSON.stringify(realtimeKeepalivePong)}))`,
          "  })",
          "}",
          "",
        ].join("\n"))
      }
      else if (build && authority === "auto" && !nodeAuthority) {
        throw realtimeErrorDiagnostics.REALTIME_MISSING_AUTHORITY()
      }
      else if (authority !== "auto" && !node && host) {
        throw realtimeErrorDiagnostics.REALTIME_AUTHORITY_CONFLICT({ authority, host })
      }
      if (nodeAuthority) inspectionAuthority = nodeAuthority === "auto" ? "node" : nodeAuthority
      else if (authority === "memory" || authority === "postgres" || authority === "redis" || (authority === "auto" && !build && inspectionAuthority !== "cloudflare")) {
        inspectionAuthority = "memory"
      }
      nitro.features = { ...nitro.features, websocket: true }
      const kit = createNitroServerKit(nitro)
      const { mount } = viteHubPageToolsBase(config)
      kit.addHandler({ handler: handlerFile, lazy: true, route: `${mount}/api/_vitehub/realtime/**` })
      if (durablePlugin) kit.addPlugin(durablePlugin)
      if (busPlugin) kit.addPlugin(busPlugin)
      for (const plugin of contribution?.plugins ?? []) kit.addPlugin(plugin)
      Object.assign(nitro, kit.config)
      ;(config as UserConfig & { nitro?: NitroConfig }).nitro = nitro
    },
    async buildStart() {
      // The Database integration resolves its Definitions after this plugin made the Nitro config. Read them again, and
      // write the handler again when the Default Database moved to or from Postgres. An unresolved Database changes
      // nothing.
      const databaseConfig = databasePlugin?.api?.getConfig?.()
      if (!databaseConfig || !nodeWrite) return
      postgresDatabase = databaseConfig.databases.default?.dialect === "postgresql"
      if (nodeWrite.postgres === postgresDatabase) return
      nodeWrite.postgres = postgresDatabase
      const files = renderNodeFiles({ ...nodeWrite, database: postgresDatabase ? databaseImport : undefined, importBase })
      await Promise.all(files.map(([file, contents]) => writeFile(file, contents)))
    },
    resolveId: {
      filter: { id: /^#vitehub\/realtime\/availability$/ },
      handler(id) {
        if (id === realtimeAvailabilityId) return resolvedRealtimeAvailabilityId
      },
    },
    load: {
      filter: { id: /^\0#vitehub\/realtime\/availability$/ },
      handler(id) {
        if (id === resolvedRealtimeAvailabilityId) {
          return hasRoomAuthority ? "export default { available: true }\n" : `export default ${JSON.stringify(unavailable)}\n`
        }
      },
    },
  }
}
