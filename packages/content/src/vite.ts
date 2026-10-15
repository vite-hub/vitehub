import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { findContentEntry, inspectContentEntry } from "@vite-hub/source/vite"

import type { ViteHubConsoleDocumentEditorSection, ViteHubConsoleDocumentSetup } from "@vite-hub/internal/console"

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
