import { existsSync, readdirSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { installStandaloneOperationRpc, publishStandaloneOperationServer } from "@vite-hub/internal/operations-vite"

import { syncErrors } from "./errors.ts"
import { syncTableNames } from "./table-names.ts"

import type { OperationContributions } from "@vite-hub/internal/operations"
import type { Plugin, UserConfig } from "vite"

export const SYNC_VITE_PLUGIN_NAME = "@vite-hub/sync/vite"

/** The route of every Sync definition, below the app base. */
export const syncRouteBase = "/api/_vitehub/sync"

/** The generated declaration of `ViteHubSyncMap`. `.vitehub/types.d.ts` references every file of `.vitehub/types`. */
const typesEntry = ".vitehub/types/sync.d.ts"

const extensions = [".ts", ".mts", ".js", ".mjs"]
const namePattern = /^[a-z0-9][a-z0-9-]*$/

/** One file of `server/sync/`. */
export interface DiscoveredSync {
  name: string
  file: string
}

/** The Sync definitions of `<serverDir>/sync/<name>.ts`. A name is lowercase letters, digits, and dashes. */
export function discoverSync(projectRoot: string, serverDirs: readonly string[] = ["server"]): DiscoveredSync[] {
  const found = new Map<string, DiscoveredSync>()
  for (const directory of serverDirs) {
    const folder = resolve(projectRoot, directory, "sync")
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const extension = extensions.find(candidate => entry.name.endsWith(candidate))
      if (!entry.isFile() || !extension || entry.name.endsWith(".d.ts")) continue
      const name = entry.name.slice(0, -extension.length)
      const file = join(folder, entry.name)
      if (!namePattern.test(name)) {
        throw syncErrors.SYNC_INVALID_NAME({ message: `[vitehub] The Sync definition ${relative(projectRoot, file)} needs a name of lowercase letters, digits, and dashes, such as todos or shopping-list.` })
      }
      const previous = found.get(name)
      if (previous) {
        throw syncErrors.SYNC_INVALID_NAME({ message: `[vitehub] Two files define the Sync name ${JSON.stringify(name)}: ${relative(projectRoot, previous.file)} and ${relative(projectRoot, file)}.` })
      }
      found.set(name, { name, file })
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Whether the app has a Sync definition. `vite-hub` uses it to turn the Database on. */
export function usesSync(options: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return discoverSync(options.projectRoot, options.serverDirs).length > 0
}

/** The module specifiers that the generated handler imports. `vite-hub` passes its own subpaths. */
export interface SyncImports {
  runtime: string
  operations: string
  database: string
  databases: string
  auth?: string
}

export interface HubSyncOptions {
  imports?: Partial<SyncImports>
  /** The app has a ViteHub Database. Sync needs it: without it, a `server/sync/` folder fails the build. Default `true`. */
  database?: boolean
  /** The app has ViteHub Auth: pass the signed-in user and session to `where` and `write`. */
  auth?: boolean
}

const defaultImports: SyncImports = {
  runtime: "@vite-hub/sync/runtime",
  operations: "@vite-hub/sync/operations",
  database: "@vite-hub/sync/database",
  databases: "@vite-hub/database/runtime/registry",
  auth: "@vite-hub/auth/server",
}

function moduleSpecifier(file: string): string {
  return file.replaceAll("\\", "/")
}

/** The generated `{ fetch }` route of every Sync definition. */
export function renderSyncHandler(definitions: readonly DiscoveredSync[], options: HubSyncOptions & { imports: SyncImports }): string {
  const { imports } = options
  const auth = options.auth && imports.auth
  return [
    `import { createSyncHandler } from ${JSON.stringify(imports.runtime)}`,
    `import { databases } from ${JSON.stringify(imports.databases)}`,
    ...auth ? [`import { useAuth } from ${JSON.stringify(auth)}`] : [],
    ...definitions.map((definition, index) => `import sync${index} from ${JSON.stringify(moduleSpecifier(definition.file))}`),
    "",
    "export default createSyncHandler({",
    `  definitions: { ${definitions.map((definition, index) => `${JSON.stringify(definition.name)}: sync${index}`).join(", ")} },`,
    "  databases,",
    ...auth
      ? [
          "  session: async (request) => {",
          "    const found = await useAuth(request).api.getSession({ headers: request.headers })",
          "    return found?.user && typeof found.user.id === \"string\" ? { user: found.user, session: found.session ?? null } : null",
          "  },",
        ]
      : [],
    "})",
    "",
  ].join("\n")
}

/** The declaration that types `useSync("<name>")` with the row of each definition. */
export function renderSyncTypes(definitions: readonly DiscoveredSync[]): string {
  return [
    "declare global {",
    "  interface ViteHubSyncMap {",
    ...definitions.map(({ name, file }) => `    ${JSON.stringify(name)}: typeof import(${JSON.stringify(moduleSpecifier(file).replace(/\.(?:ts|js)$/, ""))}).default`),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

async function writeIfChanged(file: string, contents: string): Promise<void> {
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
}

/**
 * Sync in a ViteHub app: each `server/sync/<name>.ts` that default-exports `defineSync()` gets the route
 * `<base>api/_vitehub/sync/<name>`, its change log goes to the `vitehub_sync_*` tables of the Database, and
 * `useSync("<name>")` gets the row type.
 */
export function hubSync(options: HubSyncOptions = {}): Plugin & { vitehub: { databases: (context: { projectRoot?: string, root?: string, rootDir?: string }) => unknown[], operations: OperationContributions } } {
  const imports: SyncImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: readonly string[] | undefined
  return {
    name: SYNC_VITE_PLUGIN_NAME,
    enforce: "pre",
    vitehub: {
      // `vitehub sync` and MCP read the definitions and the change log through these operations.
      operations: () => usesSync({ projectRoot: projectRoot ?? process.cwd(), ...(serverDirs ? { serverDirs } : {}) })
        ? [{ export: "syncOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).syncOperations, module: imports.operations }]
        : [],
      databases(context) {
        const root = projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd()
        if (options.database === false || !usesSync({ projectRoot: root, ...(serverDirs ? { serverDirs } : {}) })) return []
        return [{
          definition: { export: "syncSchema", module: imports.database },
          dialect: "sqlite",
          tables: syncTableNames,
          name: "sync",
          reason: "Keeps the change log of `server/sync/`.",
        }]
      },
    },
    config: {
      async handler(config: UserConfig, env) {
        const configuredRoot: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
        const dirs: unknown = Reflect.get(config, VITEHUB_SERVER_DIRS)
        serverDirs = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : undefined
        const directory = resolve(projectRoot, ".vitehub/nitro/sync")
        const types = resolve(projectRoot, typesEntry)
        const definitions = discoverSync(projectRoot, serverDirs)
        if (!definitions.length) {
          await Promise.all([rm(directory, { force: true, recursive: true }), rm(types, { force: true })])
          return
        }
        if (options.database === false) {
          throw syncErrors.SYNC_NO_DATABASE({ message: `[vitehub] server/sync/ has ${definitions.length === 1 ? "a Sync definition" : "Sync definitions"}, and the Database is off. Sync keeps its change log and rows in the Database.` })
        }
        const handler = join(directory, "handler.mjs")
        await Promise.all([
          writeIfChanged(handler, renderSyncHandler(definitions, { ...options, imports })),
          writeIfChanged(types, renderSyncTypes(definitions)),
        ])
        const { mount } = viteHubPageToolsBase(config)
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        // Not lazy: the handler installs the definitions when the server starts, so `recordSyncChanges()` and the
        // operations work before the first Sync request.
        kit.addHandler({ handler, lazy: false, route: `${mount}${syncRouteBase}/**` })
        Reflect.set(config, "nitro", kit.config)
        await installStandaloneOperationRpc(config, env?.command ?? "build", imports.operations)
      },
    },
    configureServer(server) {
      publishStandaloneOperationServer(server)
    },
  }
}
