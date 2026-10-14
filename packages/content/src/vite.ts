import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { registerViteHubNitroDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { findContentEntry, inspectContentEntry, toRuntimeModuleSpecifier } from "@vite-hub/source/vite"

import { contentDevHeader, contentDevHeaderValue, contentDevRoute, contentDevRuntimeRoute } from "./dev.ts"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubConsoleDocumentEditorSection, ViteHubConsoleDocumentSetup } from "@vite-hub/internal/console"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"

export interface ContentConsoleOptions {
  projectRoot: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
  /**
   * Files of the Schedule Definitions that the project runs, from Schedule discovery. Undefined when the project does
   * not enable Schedule, so no Schedule Definition runs.
   */
  schedules?: readonly string[]
}

type AstNode = Record<string, unknown>

function isAstNode(value: unknown): value is AstNode {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** Whether a parsed module calls a member named `publishDue`, such as `content.publishDue()`, anywhere. */
function callsPublishDue(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(callsPublishDue)
  if (!isAstNode(node)) return false
  if (node.type === "CallExpression" && isAstNode(node.callee) && node.callee.type === "MemberExpression") {
    const property = node.callee.property
    const name = isAstNode(property) ? (node.callee.computed ? property.value : property.name) : undefined
    if (name === "publishDue") return true
  }
  return Object.entries(node).some(([key, value]) => key !== "type" && Object(value) === value && callsPublishDue(value))
}

/**
 * The Schedule Definition that runs scheduled Content publishes: the first file that calls `publishDue()`, such as
 * `handler: () => content.publishDue()`. Discovery reads the files without running them, so the call must be in the
 * Schedule Definition file itself. Returns undefined when no file calls it.
 */
export async function findContentPublishRunner(schedules: readonly string[]): Promise<string | undefined> {
  // `vite` is an optional peer. Discovery runs inside Vite, so it is installed there.
  const { parseAst } = await import("vite")
  for (const file of schedules) {
    let source: string
    try {
      source = await readFile(file, "utf8")
    }
    catch {
      continue
    }
    // A file without the name cannot call it, so most files skip the parse.
    if (!source.includes("publishDue")) continue
    try {
      if (callsPublishDue(parseAst(source, { lang: /\.[cm]?ts$/.test(file) ? "ts" : "js" }))) return file
    }
    catch {
      // Schedule reports the syntax error.
    }
  }
}

/**
 * What the Content editor lacks, read without running the app. Scheduled publishes need a Schedule Definition that calls
 * `content.publishDue()`; without one, schedules never publish and only turn overdue.
 */
async function inspectContentSetup(options: ContentConsoleOptions): Promise<ViteHubConsoleDocumentSetup> {
  if (options.schedules && await findContentPublishRunner(options.schedules)) return {}
  return {
    schedule: {
      message: options.schedules
        ? "Nothing publishes scheduled documents. Add a Schedule Definition that calls `content.publishDue()`."
        : "Nothing publishes scheduled documents. Enable Schedule and add a Schedule Definition that calls `content.publishDue()`.",
      docs: "https://vitehub.dev/docs/content/scheduling#run-due-schedules",
    },
  }
}

/**
 * Finds the Content module of the project, but only when it may define document collections. Discovery reads the
 * `defineContent()` call without running it; anything it cannot follow, such as options imported from another file,
 * counts as maybe.
 */
async function findContentCollectionsEntry(options: ContentConsoleOptions): Promise<string | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  return (await inspectContentEntry(file)).collections ? file : undefined
}

/**
 * Console section for Content. It edits the document collections of the `content` export of `server/content.ts`.
 * Every action checks `content.can()` with the signed-in Console user. The Console shows the section only when
 * `defineContent()` defines document collections; a Content file with only read-only Sources has nothing to edit.
 */
export const contentConsoleSection: ViteHubConsoleDocumentEditorSection<ContentConsoleOptions> = {
  actions: { export: "createContentConsoleActions", module: "@vite-hub/content/runtime/console" },
  description: "Edit, publish, and restore Content documents.",
  entry: options => findContentCollectionsEntry(options),
  inspect: options => inspectContentSetup(options),
  icon: "i-lucide-file-pen-line",
  id: "content",
  label: "Content",
  pages: [
    { id: "dashboard", label: "Dashboard", icon: "i-lucide-layout-dashboard", index: true, view: { kind: "document-dashboard" } },
    { id: "settings", label: "Settings", icon: "i-lucide-settings-2", group: "Manage", view: { kind: "document-settings" } },
    { id: "media", label: "Media", icon: "i-lucide-image", group: "Manage", requires: ["blob"], view: { kind: "media-library" } },
  ],
  view: {
    kind: "document-editor",
    notice: "Saves commit to the draft ref of the Content Workspace. Publishing copies documents to the published ref, which /api/content serves. content.can() decides what each user may read, write, and publish.",
  },
}

/** Where ViteHub generates the Content Realtime Definition. Realtime calls it only when the build has a room authority. */
export interface ContentRealtimeContributionOptions {
  /** The room authority: Durable Objects on Cloudflare, or one process. */
  authority: "cloudflare" | "memory"
  /** Directory for the generated files, such as `.vitehub/nitro/realtime`. */
  directory: string
  projectRoot: string
  serverDirs?: string[]
  /** Module that exports `contentRealtime` and `installContentLive`, such as `vite-hub/content/realtime`. */
  contentImport: string
  /** Module that exports `refreshRealtimeDocument`, such as `vite-hub/realtime/server`. */
  realtimeImport: string
  /** The identity and access of the Console, when the Console edits Content: a module and its `consoleRealtimeAccess` export. */
  console?: { module: string, section: string }
}

/** The name of the Realtime Definition that serves Content documents. */
export const contentRealtimeDefinitionName = "content"

/**
 * The Realtime Definition and Nitro plugin of Content live editing, when the project defines Content collections and
 * does not set `live: false`. The definition serves rooms `<collection>/<id>` with `contentRealtime()`; the plugin
 * installs live editing in each server process, so Content writes from outside a room refresh it and the Console
 * knows to join rooms. Returns undefined when Content has nothing to edit live.
 */
export async function contributeContentRealtime(options: ContentRealtimeContributionOptions): Promise<{ definitions: Array<{ handler: string, name: string }>, plugins: string[] } | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  const features = await inspectContentEntry(file)
  if (!features.collections || !features.live) return
  const definition = join(options.directory, "content.mjs")
  const plugin = join(options.directory, "content-live.mjs")
  const name = JSON.stringify(contentRealtimeDefinitionName)
  await mkdir(options.directory, { recursive: true })
  await Promise.all([
    writeFile(definition, [
      `import { content } from ${JSON.stringify(pathToFileURL(file).href)}`,
      `import { contentRealtime } from ${JSON.stringify(options.contentImport)}`,
      ...(options.console
        ? [
            `import { consoleRealtimeAccess } from ${JSON.stringify(options.console.module)}`,
            "",
            "// The Console session names the people in a room, and Console section access gates it before content.can().",
            `export default contentRealtime(content, consoleRealtimeAccess(${JSON.stringify(options.console.section)}))`,
          ]
        : ["", "export default contentRealtime(content)"]),
      "",
    ].join("\n")),
    writeFile(plugin, [
      `import { installContentLive } from ${JSON.stringify(options.contentImport)}`,
      `import { refreshRealtimeDocument } from ${JSON.stringify(options.realtimeImport)}`,
      ...(options.authority === "cloudflare"
        ? [
            'import { env } from "cloudflare:workers"',
            "",
            "export default function viteHubContentLive() {",
            `  installContentLive({ definition: ${name}, refresh: documentId => refreshRealtimeDocument(${name}, documentId, { durableObjects: env.$DurableObject }) })`,
            "}",
          ]
        : [
            "",
            "export default function viteHubContentLive() {",
            `  installContentLive({ definition: ${name}, refresh: documentId => refreshRealtimeDocument(${name}, documentId) })`,
            "}",
          ]),
      "",
    ].join("\n")),
  ])
  return { definitions: [{ handler: definition, name: contentRealtimeDefinitionName }], plugins: [plugin] }
}

export const CONTENT_VITE_PLUGIN_NAME = "@vite-hub/content/vite"
const contentPackageName = "@vite-hub/content"
const generatedNitroDevHandler = ".vitehub/nitro/content/dev-handler.ts"

/** Message that the Content dev endpoint returns when the host does not run Nitro in the Vite process. */
export const contentDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Content runtime. `vitehub content` commands need a Vite + Nitro host. Nuxt and plain Vite are not supported."

export interface ContentVitePluginOptions {
  /** Import prefix of the generated Nitro dev handler, for example `vite-hub/_internal/content`. Defaults to `@vite-hub/content`. */
  importBase?: string
}

export type ContentVitePlugin = Plugin & {
  vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata
}

type ContentPluginConfig = UserConfig & {
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
}

/** Renders the dev-only Nitro handler that passes `vitehub content` requests to the app's Content runtime. */
export function renderContentDevHandler(options: { definition: string, importBase?: string }): string {
  return [
    "import { defineEventHandler } from 'h3'",
    `import { handleContentDevRequest } from ${JSON.stringify(`${options.importBase ?? contentPackageName}/runtime/dev`)}`,
    `import * as definition from ${JSON.stringify(toRuntimeModuleSpecifier(options.definition))}`,
    "",
    "export default defineEventHandler(event => handleContentDevRequest(event.req, definition.content))",
    "",
  ].join("\n")
}

function readNitroBaseURL(config: ResolvedConfig | undefined): string | undefined {
  const nitro: unknown = config ? Reflect.get(config, "nitro") : undefined
  const baseURL: unknown = nitro !== null && Object(nitro) === nitro ? Reflect.get(Object(nitro), "baseURL") : undefined
  return String(baseURL) === baseURL ? baseURL : process.env.NITRO_APP_BASE_URL
}

/**
 * Registers the `vitehub content` commands, the Content Definition inspector, and the dev-only endpoint those
 * commands call. The endpoint forwards each operation into the Nitro dev environment, where `server/content.ts`
 * and its Workspace Store live. Deployed apps have no such endpoint.
 */
export function hubContent(options: ContentVitePluginOptions = {}): ContentVitePlugin {
  let projectRoot = process.cwd()
  let serverDirs: string[] | undefined
  let resolved: ResolvedConfig | undefined
  const discover = () => findContentEntry({ projectRoot, serverDirs })

  return {
    name: CONTENT_VITE_PLUGIN_NAME,
    enforce: "post",
    vitehub: {
      cli: async () => {
        if (!await discover()) return
        const { createContentCliContributor } = await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js")
        return createContentCliContributor()
      },
      inspect: async () => {
        const definition = await discover()
        if (!definition) return
        return {
          definitions: [{
            kind: "content",
            label: "Content",
            list: () => [{
              fields: [
                { label: "Route", value: "/api/content/**" },
                { label: "Collections", value: "vitehub content collections" },
              ],
              file: relativeDefinitionFile(projectRoot, definition),
              name: "content",
              source: "server-content",
            }],
          }],
        }
      },
    },
    config: {
      order: "pre",
      async handler(config, env) {
        // SAFETY: ViteHub attaches its symbol-keyed project metadata to the user config.
        const viteConfig = config as ContentPluginConfig
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
          ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
          : resolveViteHubProjectRoot(config.root || process.cwd())
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS] ?? serverDirs
        if (env.command !== "serve") return
        const handler = resolve(projectRoot, generatedNitroDevHandler)
        const definition = await discover()
        if (!definition) {
          await rm(handler, { force: true })
          return
        }
        await mkdir(dirname(handler), { recursive: true })
        await writeFile(handler, renderContentDevHandler({ definition, importBase: options.importBase }), "utf8")
        // Vite keeps the `nitro` key that the Nitro Vite plugin reads. The kit copies it and adds one handler.
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addHandler({ handler, route: contentDevRuntimeRoute })
        Reflect.set(config, "nitro", kit.config)
      },
    },
    configResolved(config) {
      resolved = config
    },
    configureServer(server) {
      registerViteHubNitroDevEndpoint(server, {
        header: contentDevHeader,
        headerValue: contentDevHeaderValue,
        label: "Content Dev",
        nitroBaseURL: () => readNitroBaseURL(resolved),
        route: contentDevRoute,
        runtimeRoute: contentDevRuntimeRoute,
        unavailable: { code: "CONTENT_DEV_RUNTIME_UNAVAILABLE", message: contentDevRuntimeUnavailableMessage },
      })
    },
  }
}
