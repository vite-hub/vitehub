import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { commentsErrorDiagnostics } from "./errors.ts"

import type { DatabaseContributionEntry } from "@vite-hub/database/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributions } from "@vite-hub/internal/operations"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"

export { commentsConsoleSection } from "./console.ts"

export const COMMENTS_VITE_PLUGIN_NAME = "@vite-hub/comments/vite"

/** Generated Nitro plugin that installs the comments runtime, relative to the project root. */
export const commentsNitroPluginPath = ".vitehub/nitro/comments/plugin.mjs"

const entryName = /^comments\.[cm]?[jt]s$/

/** Import paths of the generated runtime. The `vite-hub` integration passes its own subpaths, so the module resolves from the app. */
export interface CommentsImports {
  auth: string
  database: string
  databaseSchema: string
  operations: string
  runtime: string
}

export interface HubCommentsOptions {
  /** Database Definition that receives the tables. Defaults to the default or only Database. */
  database?: string
  /** SQL dialect of that Database. `postgresql` uses the Postgres tables. Default `sqlite`: SQLite, libSQL, and D1. */
  dialect?: "postgresql" | "sqlite"
  /** Find people through the app Auth for @mentions. Default `false`: the authors that comments know. */
  auth?: boolean
  imports?: Partial<CommentsImports>
}

const defaultImports: CommentsImports = {
  auth: "@vite-hub/auth/server",
  database: "@vite-hub/database/drizzle",
  databaseSchema: "@vite-hub/comments/database",
  operations: "@vite-hub/comments/operations",
  runtime: "@vite-hub/comments/server",
}

type CommentsPluginConfig = UserConfig & {
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
}

export type CommentsVitePlugin = Plugin & {
  vitehub: {
    databases: (context: { projectRoot?: string, root?: string, serverDirs?: readonly string[] }) => Promise<readonly DatabaseContributionEntry[]>
    operations: OperationContributions
  } & ViteHubInspectionPluginMetadata
}

function candidates(projectRoot: string, serverDirs: readonly string[] | undefined): string[] {
  const directories = serverDirs === undefined ? [resolve(projectRoot, "server")] : serverDirs.map(directory => resolve(projectRoot, directory))
  return directories.flatMap(directory => ["comments.ts", "comments.mts", "comments.js", "comments.mjs"].map(name => join(directory, name))).filter(file => entryName.test(file.slice(file.lastIndexOf("/") + 1)))
}

/** The `server/comments.{ts,js}` file of the project, or undefined. */
export function findCommentsEntry(options: { projectRoot: string, serverDirs?: readonly string[] }): string | undefined {
  return candidates(options.projectRoot, options.serverDirs).find(file => existsSync(file))
}

/** Whether the project has a `server/comments.ts`. `vitehub()` reads it while Vite filters plugins. */
export function usesComments(options: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return findCommentsEntry(options) !== undefined
}

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

/** The Nitro plugin that installs the comments runtime in each server process. */
export function renderCommentsNitroPlugin(options: { auth: boolean, database?: string, entry: string, imports: CommentsImports }): string {
  const name = options.database === undefined ? "undefined" : JSON.stringify(options.database)
  return [
    `import { databases } from ${JSON.stringify(options.imports.database)}`,
    `import { createAuthUsers, createCommentsStore, installComments } from ${JSON.stringify(options.imports.runtime)}`,
    ...(options.auth ? [`import { getAuth } from ${JSON.stringify(options.imports.auth)}`] : []),
    `import * as app from ${JSON.stringify(pathToFileURL(options.entry).href)}`,
    "",
    `const databaseName = ${name}`,
    "",
    "function entry() {",
    "  const list = Object.values(databases)",
    "  const found = databaseName === undefined ? databases.default ?? (list.length === 1 ? list[0] : undefined) : databases[databaseName]",
    "  if (!found?.db) throw new Error(\"[vitehub] Comments found no Database. Define one, or set hubComments({ database }).\")",
    "  return found",
    "}",
    "",
    "export default function viteHubComments() {",
    "  installComments(() => {",
    "    const { db, schema } = entry()",
    "    return {",
    "      definition: app.default ?? app.comments,",
    "      store: createCommentsStore(db, { commentMessages: schema.commentMessages, commentThreads: schema.commentThreads }),",
    ...(options.auth ? ["      users: createAuthUsers(() => getAuth()),"] : []),
    "    }",
    "  })",
    "}",
    "",
  ].join("\n")
}

/**
 * Comments build integration. When the project has `server/comments.ts`, it contributes the comment tables to the
 * Database, the `comments.*` operations, and a Nitro plugin that installs the runtime. Apps without the file are
 * unaffected.
 */
export function hubComments(options: HubCommentsOptions = {}): CommentsVitePlugin {
  const imports: CommentsImports = { ...defaultImports, ...options.imports }
  const postgres = options.dialect === "postgresql"
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  const discover = () => findCommentsEntry({ projectRoot: projectRoot ?? process.cwd(), serverDirs })
  return {
    name: COMMENTS_VITE_PLUGIN_NAME,
    enforce: "post",
    config: {
      order: "pre",
      async handler(config) {
        // SAFETY: Vite passes its user config with ViteHub's shared keys attached.
        const viteConfig = config as CommentsPluginConfig
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(viteConfig.root || process.cwd())
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
        const entry = discover()
        if (!entry) return
        const file = resolve(projectRoot, commentsNitroPluginPath)
        await writeIfChanged(file, renderCommentsNitroPlugin({ auth: options.auth === true, imports, entry, ...(options.database === undefined ? {} : { database: options.database }) }))
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addPlugin(file)
        Reflect.set(config, "nitro", kit.config)
      },
    },
    configResolved(config: ResolvedConfig) {
      const entry = discover()
      if (!entry) return
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const nitroContext = (config as ResolvedConfig & CommentsPluginConfig)[VITEHUB_NITRO_CONFIG_CONTEXT]
      const hasDatabase = nitroContext || config.plugins.some(plugin => plugin.name === "@vite-hub/database/vite")
      if (!hasDatabase) throw commentsErrorDiagnostics.COMMENTS_B0001({ file: entry.slice((projectRoot ?? "").length + 1) || entry })
    },
    vitehub: {
      databases: async () => discover()
        ? [{
            definition: { export: postgres ? "commentsPostgresSchema" : "commentsSchema", module: postgres ? `${imports.databaseSchema}/postgres` : imports.databaseSchema },
            name: "comments",
            reason: "Stores the comment threads and messages of server/comments.ts.",
            ...(options.database === undefined ? {} : { database: options.database }),
            ...(postgres ? { dialect: "postgresql" as const } : {}),
          }]
        : [],
      inspect: () => {
        const entry = discover()
        if (!entry) return undefined
        return {
          definitions: [{
            kind: "comments",
            label: "Comments",
            list: () => [{
              fields: [{ label: "Operations", value: "vitehub comments list" }],
              file: relativeDefinitionFile(projectRoot ?? process.cwd(), entry),
              name: "comments",
              source: "server-comments",
            }],
          }],
        }
      },
      // An app without server/comments.ts has nothing to comment on.
      operations: async () => discover()
        ? [{ export: "commentsOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).commentsOperations, module: imports.operations }]
        : [],
    },
  }
}
