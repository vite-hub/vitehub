import { ownModule } from "@vite-hub/internal/build/paths"
import { readdirSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { findContentEntry, inspectContentEntry, inspectContentModule } from "@vite-hub/source/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { BuiltContentSnapshot } from "./snapshots.ts"
import type { ViteHubConsoleDocumentEditorSection, ViteHubConsoleDocumentSetup } from "@vite-hub/internal/console"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributions } from "@vite-hub/internal/operations"
import type { parseAst, Plugin, UserConfig } from "vite"

export const CONTENT_VITE_PLUGIN_NAME = "@vite-hub/content/vite"

export type ContentVitePlugin = Plugin & {
  /**
   * Registers KV and ships the Source snapshots in a Nitro build outside Vite, such as Nuxt 4.7's, including prerender's
   * separate compilation.
   */
  nitro: { name: string, setup(nitro: { options: { dev?: boolean, rollupConfig?: { plugins?: unknown[] } } }): void }
  /** The `vitehub content` commands, the Content operations, and the Content Definition inspector. */
  vitehub: { operations: OperationContributions } & ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata
}

type ContentPluginConfig = UserConfig & {
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
}

export interface HubContentOptions {
  /** The module that the app imports Content from, such as `vite-hub/content`. Defaults to `@vite-hub/content`. */
  importBase?: string
}

interface InternalContentOptions extends HubContentOptions {
  /** The module that exports `kv`. `vitehub()` sets `vite-hub/kv`, which every app lists. Defaults to `@vite-hub/kv`. */
  kvImport?: string
}

/**
 * Prefix of the modules that hold Content snapshots: `<prefix><instance>` is the index, `<prefix><instance>:<n>` a shard
 * of parsed documents. `\0` keeps other plugins away.
 */
const SNAPSHOT_ID = "\0vitehub-content-snapshot:"
const SNAPSHOT_ID_PATTERN = /^\0vitehub-content-snapshot:/

const CONTENT_ENTRY_PATTERN = /\/content\.[cm]?[jt]s(?:\?.*)?$/

const CONTENT_NITRO_PLUGIN_NAME = "@vite-hub/content/nitro"

type BuiltSnapshots = { file: string, snapshots: Record<string, BuiltContentSnapshot> }

async function writeContentOperationsModule(projectRoot: string, file: string): Promise<string> {
  const module = join(projectRoot, ".vitehub/nitro/content/operations.mjs")
  const code = [
    `import { contentOperations, installContentModule } from ${JSON.stringify(ownModule(import.meta.url, "operations"))}`,
    "",
    `installContentModule(() => import(${JSON.stringify(pathToFileURL(file).href)}))`,
    "",
    "export { contentOperations }",
    "",
  ].join("\n")
  const current = await readFile(module, "utf8").catch(() => undefined)
  if (current !== code) {
    await mkdir(dirname(module), { recursive: true })
    await writeFile(module, code)
  }
  return module
}

/**
 * Load `server/content.ts` in Node and parse its read-only `glob()` and `files()` Sources once, and the branch commit of
 * each `github()` Source when the build has a GitHub token. Returns each snapshot by
 * instance name, and a warning for each Source, or the whole file, that the build could not parse.
 */
export async function buildContentSnapshotModules(options: {
  file: string
  projectRoot: string
  importBase?: string
  alias?: NonNullable<UserConfig["resolve"]>["alias"]
}): Promise<{ snapshots: Record<string, BuiltContentSnapshot>, warnings: string[] }> {
  // A module id inside the project, so `importBase` resolves from the app as the generated Content routes do.
  const entry = join(options.projectRoot, ".vitehub/content/snapshots.build.mjs")
  const code = [
    `import content from ${JSON.stringify(pathToFileURL(options.file).href)}`,
    `import { buildContentSnapshots } from ${JSON.stringify(options.importBase ?? "@vite-hub/content")}`,
    // The parse runs while the module loads: the runner closes when runnerImport() returns.
    "export default await buildContentSnapshots(content)",
  ].join("\n")
  const file = relativeDefinitionFile(options.projectRoot, options.file)
  try {
    // `vite` is an optional peer. The build runs inside Vite, so it is installed there.
    const { runnerImport } = await import("vite")
    const { module } = await runnerImport<{ default: { snapshots: Record<string, BuiltContentSnapshot>, skipped: Record<string, string> } }>(entry, {
      configFile: false,
      root: options.projectRoot,
      resolve: { alias: options.alias },
      logLevel: "silent",
      plugins: [{
        name: "vitehub:content-snapshots-entry",
        resolveId: id => id === entry ? entry : undefined,
        load: id => id === entry ? code : undefined,
      }],
    })
    const { snapshots, skipped } = module.default
    return {
      snapshots,
      warnings: Object.entries(skipped).map(([name, reason]) => `[vitehub] The build could not parse the Content Source ${JSON.stringify(name)}, so the server parses it on its first Content request: ${reason}`),
    }
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { snapshots: {}, warnings: [`[vitehub] The build could not load ${file} to parse its Content Sources, so the server parses them on its first Content request: ${reason}`] }
  }
}

let lastGitHubCheck: { file: string, source: string, uses: boolean } | undefined

/**
 * Whether `server/content.ts` imports `github()` from `vite-hub/source`. A `github()` Source keeps its head commit in
 * KV, so `vitehub()` turns KV on for it. It reads the file synchronously while Vite filters plugins, and returns false
 * when the file is missing, ambiguous, or does not parse; the Source and Content plugins report those cases.
 */
export function usesGitHubSources(input: { projectRoot: string, serverDirs?: readonly string[] }, parse: typeof parseAst): boolean {
  const root = resolve(input.projectRoot)
  const files = (input.serverDirs?.map(directory => resolve(root, directory)) ?? [resolve(root, "server")]).flatMap((directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^content\.[cm]?[jt]s$/.test(entry.name))
        .map(entry => join(directory, entry.name))
    }
    catch {
      return []
    }
  })
  if (files.length !== 1) return false
  const file = files[0]!
  const source = readFileSync(file, "utf8")
  // Vite asks once per plugin while it filters them, so parse each version of the file once.
  if (lastGitHubCheck?.file !== file || lastGitHubCheck.source !== source) {
    lastGitHubCheck = { file, source, uses: importsGitHubSource(source, file, parse) }
  }
  return lastGitHubCheck.uses
}

function importsGitHubSource(source: string, file: string, parse: typeof parseAst): boolean {
  try {
    // The same rule that adds the GitHub push webhook route.
    return inspectContentModule(parse(source, { lang: /\.[cm]?ts$/.test(file) ? "ts" : "js" })).github
  }
  catch {
    return false
  }
}

/**
 * Content build integration. When the app defines `server/content.ts`, it adds the `vitehub content` commands, the
 * Content operations, and the Content Definition inspector. The `cms` preset and the infrastructure it needs come from
 * `@vite-hub/cms/vite`.
 *
 * A server build also parses the read-only `glob()` and `files()` Sources of `server/content.ts` once and ships the
 * parsed documents, so a cold server does not parse Markdown on its first Content request. `vite dev` parses live.
 */
export function hubContent(options: HubContentOptions = {}): ContentVitePlugin {
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let alias: NonNullable<UserConfig["resolve"]>["alias"]
  let kvEnabled = false
  const discover = () => findContentEntry({ projectRoot: projectRoot ?? process.cwd(), serverDirs })
  // One parse per build: a Vite environment, or a Nitro build outside Vite. A watch build parses again on each rebuild.
  const snapshotsByBuild = new WeakMap<object, Promise<BuiltSnapshots | undefined>>()
  // Each build gets new commit cache keys, because plugin options in closures do not change the parser hash.
  const build = randomUUID()

  async function registerKV(code: string, id: string): Promise<string> {
    if (!kvEnabled || code.includes("__vitehubRegisterContentKV") || resolve(id.replace(/\?.*$/, "")) !== await discover()) return ""
    return `import { kv as __vitehubContentKV } from ${JSON.stringify((options as InternalContentOptions).kvImport ?? "@vite-hub/kv")}; import { registerContentKV as __vitehubRegisterContentKV } from ${JSON.stringify(options.importBase ?? "@vite-hub/content")}; __vitehubRegisterContentKV(__vitehubContentKV, ${JSON.stringify(build)});\n`
  }

  async function registerSnapshots(key: object, code: string, id: string, warn: (message: string) => void): Promise<string> {
    if (code.includes("__vitehubRegisterContentSnapshots")) return ""
    let built = snapshotsByBuild.get(key)
    if (!built) {
      built = (async () => {
        const file = await discover()
        if (!file) return
        const result = await buildContentSnapshotModules({ file, projectRoot: projectRoot ?? process.cwd(), importBase: options.importBase, alias })
        for (const warning of result.warnings) warn(warning)
        return { file, snapshots: result.snapshots }
      })()
      snapshotsByBuild.set(key, built)
    }
    const snapshots = await built
    const names = snapshots && resolve(id.replace(/\?.*$/, "")) === snapshots.file ? Object.keys(snapshots.snapshots) : []
    if (!names.length) return ""
    const loaders = names.map(name => `${JSON.stringify(name)}: () => import(${JSON.stringify(SNAPSHOT_ID + name)}).then(module => module.default)`)
    return `import { registerContentSnapshots as __vitehubRegisterContentSnapshots } from ${JSON.stringify(options.importBase ?? "@vite-hub/content")}; __vitehubRegisterContentSnapshots({ ${loaders.join(", ")} });\n`
  }

  async function loadSnapshot(key: object | undefined, id: string): Promise<string | undefined> {
    const built = key ? await snapshotsByBuild.get(key) : undefined
    const [name = "", shard] = id.slice(SNAPSHOT_ID.length).split(":")
    const snapshot = built?.snapshots[name]
    if (!snapshot) return
    // Gzipped JSON in base64: a host compiles the module by its gzip size, and the server decodes it on first use.
    const gzip = (text: string) => JSON.stringify(gzipSync(text, { level: 9 }).toString("base64"))
    if (shard !== undefined) return `export default ${gzip(snapshot.shards[Number(shard)]!)}`
    const shards = snapshot.shards.map((_, number) => `() => import(${JSON.stringify(`${SNAPSHOT_ID}${name}:${number}`)}).then(module => module.default)`)
    return `export default { index: ${gzip(snapshot.index)}, shards: [${shards.join(", ")}] }`
  }

  return {
    name: CONTENT_VITE_PLUGIN_NAME,
    enforce: "post",
    nitro: {
      name: "@vite-hub/content",
      setup(nitro) {
        const config = nitro.options.rollupConfig ??= {}
        const plugins = config.plugins ??= []
        if (plugins.some(plugin => plugin && typeof plugin === "object" && Reflect.get(plugin, "name") === CONTENT_NITRO_PLUGIN_NAME)) return
        const snapshots = !nitro.options.dev
        let key = {}
        plugins.push({
          name: CONTENT_NITRO_PLUGIN_NAME,
          buildStart() {
            key = {}
          },
          transform: {
            filter: { id: CONTENT_ENTRY_PATTERN },
            async handler(this: { warn(message: string): void }, code: string, id: string) {
              let registration = await registerKV(code, id)
              if (snapshots) registration += await registerSnapshots(key, code, id, message => this.warn(message))
              return registration ? { code: registration + code, map: null } : undefined
            },
          },
          resolveId: {
            filter: { id: SNAPSHOT_ID_PATTERN },
            handler: (id: string) => snapshots ? id : undefined,
          },
          load: {
            filter: { id: SNAPSHOT_ID_PATTERN },
            handler: (id: string) => snapshots ? loadSnapshot(key, id) : undefined,
          },
        })
      },
    },
    buildStart() {
      if (this.environment) snapshotsByBuild.delete(this.environment)
    },
    transform: {
      filter: { id: { include: CONTENT_ENTRY_PATTERN, exclude: /\/node_modules\// } },
      async handler(code, id) {
        const environment = this.environment
        if (!environment || environment.config.consumer !== "server") return
        // Apps without KV import none of its runtime.
        let registration = await registerKV(code, id)
        if (environment.config.command === "build") registration += await registerSnapshots(environment, code, id, message => this.warn(message))
        // Lines before the module body, so `defineContent()` below receives them.
        return registration ? { code: registration + code, map: null } : undefined
      },
    },
    resolveId: {
      filter: { id: SNAPSHOT_ID_PATTERN },
      handler: id => id,
    },
    load: {
      filter: { id: SNAPSHOT_ID_PATTERN },
      handler(id) {
        return loadSnapshot(this.environment, id)
      },
    },
    vitehub: {
      // The Console, `vitehub content`, and agents run these. The app imports them through `vite-hub`.
      // An app without server/content.ts has no Content to operate on, so it contributes nothing.
      operations: async () => {
        const file = await discover()
        if (!file) return []
        const module = await writeContentOperationsModule(projectRoot ?? process.cwd(), file)
        return [{ export: "contentOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).contentOperations, module }]
      },
      cli: async () => {
        if (!await discover()) return
        const { createContentCliContributor } = await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js")
        return createContentCliContributor()
      },
      inspect: async () => {
        const definition = await discover()
        if (!definition) return
        const features = await inspectContentEntry(definition)
        return {
          definitions: [{
            kind: "content",
            label: "Content",
            list: () => [{
              fields: [
                { label: "Route", value: features.route ? "/api/content/**" : "Disabled" },
                ...(features.github ? [{ label: "GitHub webhook", value: "POST /_vitehub/content/github" }] : []),
                ...(features.previews ? [{ label: "Previews", value: "/tree/<branch>/-/<path>, /blob/<sha>/<path>, /pr/<number>/<path>" }] : []),
                { label: "Collections", value: "vitehub content collections" },
              ],
              file: relativeDefinitionFile(projectRoot ?? process.cwd(), definition),
              name: "content",
              source: "server-content",
            }],
          }],
        }
      },
    },
    config: {
      order: "pre",
      handler(config) {
        // SAFETY: Vite passes its user config with ViteHub's shared keys attached.
        const viteConfig = config as ContentPluginConfig
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
          ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
          : resolveViteHubProjectRoot(viteConfig.root || process.cwd())
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
      },
    },
    configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as typeof config & ContentPluginConfig
      projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice() ?? serverDirs
      alias = config.resolve.alias
      kvEnabled = config.plugins.some(plugin => plugin.name === "@vite-hub/kv/vite")
    },
  }
}

export interface ContentConsoleOptions {
  projectRoot: string
  contentImportBase?: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
  /**
   * Files of the Schedule Definitions that the project runs, from Schedule discovery. Undefined when the project does
   * not enable Schedule, so no Schedule Definition runs.
   */
  schedules?: readonly string[]
  /**
   * False when the Workspace store of the collections cannot schedule publishes, such as the GitHub store of the
   * `cms` preset. The Console then does not ask for a Schedule Definition that calls `content.publishDue()`.
   */
  scheduling?: boolean
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
  if (options.scheduling === false) return {}
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
 * Finds the Content module when it may define document collections or imports `github()`. Discovery reads the
 * `defineContent()` call without running it; anything it cannot follow, such as options imported from another file,
 * counts as maybe.
 */
async function findContentConsoleEntry(options: ContentConsoleOptions): Promise<string | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  const features = await inspectContentEntry(file, options.contentImportBase)
  if (features.collections || features.github) return file
}

/**
 * Console section for Content. It edits the document collections of the default export of `server/content.ts`.
 * Document actions check `content.can()` with the signed-in Console user. The dashboard also shows GitHub Source heads.
 */
export const contentConsoleSection: ViteHubConsoleDocumentEditorSection<ContentConsoleOptions> = {
  actions: { export: "createContentConsoleActions", module: ownModule(import.meta.url, "runtime/console") },
  description: "Edit Content documents and inspect GitHub Sources.",
  entry: findContentConsoleEntry,
  async inspect(options, entry) {
    const features = await inspectContentEntry(entry, options.contentImportBase)
    if (features.github && !features.collections) return { sourceHeadsOnly: true }
    return inspectContentSetup(options)
  },
  icon: "i-vitehub-content",
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

/** Where ViteHub generates the Content Realtime Definition. Realtime calls it only when the build has a room driver. */
export interface ContentRealtimeContributionOptions {
  /** The Realtime driver: Durable Objects on Cloudflare, or one process. */
  driver: "cloudflare" | "memory"
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
      `import content from ${JSON.stringify(pathToFileURL(file).href)}`,
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
      ...(options.driver === "cloudflare"
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
