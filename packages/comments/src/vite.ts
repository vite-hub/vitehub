import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { argumentExpression, objectProperties, scanModule, staticString, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import { resolveViteHubProjectRoot, VITEHUB_APP_BASE_URL, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { findCommentsEntry, findContentEntry } from "./entry.ts"
import { commentsHintCookie, commentsHintQuery, commentsRealtimeDefinition, commentsRoute, mountedCommentsRoute } from "./page.ts"

import type { DatabaseContributionContext, DatabaseContributionEntry } from "@vite-hub/database/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, UserConfig } from "vite"

export { commentsConsoleSection } from "./console.ts"
export { findCommentsEntry } from "./entry.ts"

/** Module paths that generated files import. The `vite-hub` distribution passes its own subpaths. */
export interface CommentsImports {
  /** Exports `defineCommentsPlugin` and `createCommentsHandler`. */
  runtime: string
  /** Exports `commentsRealtime`. */
  realtime: string
  /** Exports `commentsAuthSession`. */
  auth: string
  /** Exports `commentsSchema`. */
  database: string
  /** Exports `databases`, the runtime Database registry. */
  databases: string
  /** Exports `parseContentField`. */
  contentClient: string
}

export interface CommentsVitePluginOptions {
  /** Whether the app configures ViteHub Auth, so Comments reads its session. Default `false`. */
  auth?: boolean
  imports?: Partial<CommentsImports>
}

export interface CommentsRealtimeContributionContext {
  authority: "cloudflare" | "memory"
  directory: string
  projectRoot: string
  serverDirs?: string[]
}

export type CommentsVitePlugin = Plugin & {
  api: {
    /**
     * The `comments` Realtime Definition of the page presence rooms, for `hubRealtime({ contribute })`. Realtime calls
     * it only when the host has a room authority; without one, pages show comments without presence.
     */
    contributeRealtime(context: CommentsRealtimeContributionContext): Promise<{ definitions: Array<{ handler: string, name: string }> } | undefined>
  }
  vitehub: ViteHubInspectionPluginMetadata & { databases: (context: DatabaseContributionContext) => Promise<DatabaseContributionEntry[]> }
}

const defaultImports: CommentsImports = {
  runtime: "@vite-hub/comments/runtime",
  realtime: "@vite-hub/comments/realtime",
  auth: "@vite-hub/comments/runtime/auth",
  database: "@vite-hub/comments/database",
  databases: "@vite-hub/database/drizzle",
  contentClient: "@vite-hub/content/client",
}

/**
 * The Database name in `defineComments({ database: "name" })`, read without running the file. Undefined means the
 * default or only Database.
 */
export async function readCommentsDatabase(file: string): Promise<string | undefined> {
  const source = await readFile(file, "utf8").catch(() => "")
  const module = scanModule(source, file)
  if (module.errors.length) return
  const bindings = new Set<string>()
  const factories = new Set(["defineComments"])
  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type" && ["vite-hub/comments", "@vite-hub/comments"].includes(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
        const name = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
        if (name === "defineComments") factories.add(specifier.local.name)
      }
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue
    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === "Identifier" && declaration.id.name === "comments") bindings.add(declaration.id.name)
      }
    }
    for (const specifier of statement.specifiers) {
      const name = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
      if (name === "comments" && specifier.local.type === "Identifier") bindings.add(specifier.local.name)
    }
  }
  for (const statement of module.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type !== "VariableDeclaration") continue
    for (const binding of declaration.declarations) {
      if (binding.id.type !== "Identifier" || !bindings.has(binding.id.name) || !binding.init) continue
      const call = unwrapExpression(binding.init)
      if (call.type !== "CallExpression" || call.callee.type !== "Identifier" || !factories.has(call.callee.name)) continue
      const options = argumentExpression(call.arguments[0])
      if (options?.type !== "ObjectExpression") return
      for (const property of objectProperties(options).reverse()) {
        // A later spread or dynamic key may replace an earlier Database option.
        if (property.key === undefined) return
        if (property.key !== "database") continue
        if (property.node.type !== "Property" || property.node.kind !== "init" || property.node.method) return
        return staticString(property.value)
      }
      return
    }
  }
}

/** The directory of the prebuilt overlay script in this package. */
export function commentsOverlayDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Built: dist/vite.js next to dist/overlay. From source in tests: src/vite.ts, so use the built copy.
  return here.endsWith("src") ? resolve(here, "../dist/overlay") : resolve(here, "overlay")
}

const version = "1"

/** Generated session reader: the ViteHub Auth user of a request. */
function sessionLines(auth: boolean, imports: CommentsImports): { imports: string[], value: string } {
  return auth
    ? { imports: [`import { commentsAuthSession } from ${JSON.stringify(imports.auth)}`], value: "commentsAuthSession" }
    : { imports: [], value: "undefined" }
}

export function renderCommentsHandler(input: { definition: string, content?: string, auth: boolean, realtime: boolean, imports: CommentsImports }): string {
  const session = sessionLines(input.auth, input.imports)
  return [
    `import { createCommentsHandler } from ${JSON.stringify(input.imports.runtime)}`,
    `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
    ...session.imports,
    ...(input.content
      ? [
          `import * as contentModule from ${JSON.stringify(pathToFileURL(input.content).href)}`,
          `import { parseContentField } from ${JSON.stringify(input.imports.contentClient)}`,
        ]
      : []),
    "",
    "export default createCommentsHandler({",
    "  comments,",
    `  session: ${session.value},`,
    ...(input.content ? ["  content: contentModule.content ? { runtime: contentModule.content, parseField: parseContentField } : undefined,"] : []),
    `  realtime: ${input.realtime},`,
    "})",
    "",
  ].join("\n")
}

export function renderCommentsPlugin(input: { definition: string, database?: string, imports: CommentsImports, base?: string }): string {
  return [
    `import { defineCommentsPlugin } from ${JSON.stringify(input.imports.runtime)}`,
    `import { databases } from ${JSON.stringify(input.imports.databases)}`,
    `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
    "",
    "// The Database that `defineComments({ database })` names, else `default`, else the only one.",
    "function database() {",
    `  const name = ${JSON.stringify(input.database ?? null)}`,
    "  if (name) return databases[name]?.db",
    "  // Without a default Database, `databases.default` is a placeholder that throws when read.",
    "  try {",
    "    if (databases.default.db.select) return databases.default.db",
    "  }",
    "  catch {}",
    "  const names = Object.keys(databases).filter(key => key !== \"default\")",
    "  return names.length === 1 ? databases[names[0]].db : undefined",
    "}",
    "",
    `export default defineCommentsPlugin({ comments, database, overlay: ${JSON.stringify(`${mountedCommentsRoute(input.base)}/assets/overlay.js?v=${version}`)} })`,
    "",
  ].join("\n")
}

/**
 * Comments build integration. When the app has `server/comments.ts`, it serves the Comments API at
 * `/api/_vitehub/comments/**`, installs the runtime with its Database, adds the tables to that Database, serves the
 * overlay script, and adds it to pages in comment mode. Apps without the file are unaffected.
 */
export function hubComments(options: CommentsVitePluginOptions = {}): CommentsVitePlugin {
  const imports: CommentsImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let realtime = false
  let route = commentsRoute
  const discover = () => findCommentsEntry(projectRoot ?? process.cwd(), serverDirs)

  return {
    name: "@vite-hub/comments/vite",
    api: {
      async contributeRealtime(context) {
        const definition = findCommentsEntry(context.projectRoot, context.serverDirs)
        if (!definition) return
        realtime = true
        const file = join(context.directory, "comments.mjs")
        const session = sessionLines(options.auth ?? false, imports)
        await mkdir(context.directory, { recursive: true })
        await writeFile(file, [
          `import { commentsRealtime } from ${JSON.stringify(imports.realtime)}`,
          `import { comments } from ${JSON.stringify(pathToFileURL(definition).href)}`,
          ...session.imports,
          "",
          `export default commentsRealtime(comments, { session: ${session.value} })`,
          "",
        ].join("\n"))
        return { definitions: [{ handler: file, name: commentsRealtimeDefinition }] }
      },
    },
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "comments",
          label: "Comments",
          list: () => {
            const definition = discover()
            if (!definition) return []
            return [{
              fields: [
                { label: "Route", value: `${route}/**` },
                { label: "Presence", value: realtime ? `Realtime Definition "${commentsRealtimeDefinition}"` : "off: the host has no Realtime authority" },
                { label: "Comment mode", value: `?${commentsHintQuery} or the ${commentsHintCookie} cookie` },
              ],
              file: relativeDefinitionFile(projectRoot ?? process.cwd(), definition),
              name: "comments",
              source: "server-comments",
            }]
          },
        }],
      }),
      async databases(context) {
        const root = projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd()
        const definition = findCommentsEntry(root, serverDirs ?? context.serverDirs?.slice())
        if (!definition) return []
        const database = await readCommentsDatabase(definition)
        return [{
          ...(database ? { database } : {}),
          definition: { export: "commentsSchema", module: imports.database },
          dialect: "sqlite",
          name: "comments",
          reason: "Stores the comment threads of `server/comments.ts`.",
        }]
      },
    },
    // `vitehub()` adds this plugin after Realtime, so Realtime's contribution says whether presence runs.
    enforce: "pre",
    config: {
      async handler(config) {
        // SAFETY: Vite passes its user config with ViteHub's shared keys attached.
        const viteConfig = config as UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[], [VITEHUB_APP_BASE_URL]?: string }
        const base = viteConfig[VITEHUB_APP_BASE_URL] ?? config.base
        route = mountedCommentsRoute(base)
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(resolve(config.root || process.cwd()))
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
        const directory = resolve(projectRoot, ".vitehub/nitro/comments")
        const definition = discover()
        if (!definition) {
          await rm(directory, { force: true, recursive: true })
          return
        }
        const handler = join(directory, "handler.mjs")
        const plugin = join(directory, "plugin.mjs")
        await mkdir(directory, { recursive: true })
        await Promise.all([
          writeFile(handler, renderCommentsHandler({ definition, content: findContentEntry(projectRoot, serverDirs), auth: options.auth ?? false, realtime, imports })),
          writeFile(plugin, renderCommentsPlugin({ definition, database: await readCommentsDatabase(definition), imports, base })),
        ])
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addHandler({ handler, route: `${route}/**` })
        kit.addPlugin(plugin)
        const nitro = kit.config
        const assets = Array.isArray(nitro.publicAssets) ? [...nitro.publicAssets] : []
        const overlay = commentsOverlayDirectory()
        if (!assets.some(asset => Object(asset) === asset && Reflect.get(Object(asset), "dir") === overlay)) {
          assets.push({ baseURL: `${route}/assets`, dir: overlay, maxAge: 300 })
        }
        nitro.publicAssets = assets
        Reflect.set(config, "nitro", nitro)
      },
    },
    // A single page app whose `index.html` Vite serves: load the overlay in the browser when the hint is present.
    transformIndexHtml() {
      if (!discover()) return
      const src = `${route}/assets/overlay.js?v=${version}`
      return [{
        tag: "script",
        attrs: { type: "module" },
        children: `if(new URLSearchParams(location.search).has(${JSON.stringify(commentsHintQuery)})||document.cookie.split("; ").includes(${JSON.stringify(`${commentsHintCookie}=1`)}))import(${JSON.stringify(src)})`,
        injectTo: "body",
      }]
    },
  }
}
