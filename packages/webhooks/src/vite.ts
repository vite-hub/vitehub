import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { isDefinitionSourceFile } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { webhooksErrors } from "./errors.ts"
import { webhooksQueueName } from "./queue-name.ts"
import { webhooksTableNames } from "./table-names.ts"

import type { OperationContributions } from "@vite-hub/internal/operations"
import type { Plugin, UserConfig } from "vite"

export { webhooksQueueName }

export const WEBHOOKS_VITE_PLUGIN_NAME = "@vite-hub/webhooks/vite"

const extensions = [".ts", ".mts", ".js", ".mjs"]
const namePattern = /^[a-z0-9][a-z0-9-]*$/

/** One file of `server/webhooks/`. */
export interface DiscoveredWebhook {
  name: string
  file: string
}

/** The webhooks of `<serverDir>/webhooks/<name>.ts`. A name is lowercase letters, digits, and dashes. */
export function discoverWebhooks(projectRoot: string, serverDirs: readonly string[] = ["server"]): DiscoveredWebhook[] {
  const found = new Map<string, DiscoveredWebhook>()
  for (const directory of serverDirs) {
    const folder = resolve(projectRoot, directory, "webhooks")
    if (!existsSync(folder)) continue
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const extension = extensions.find(candidate => entry.name.endsWith(candidate))
      if (!entry.isFile() || !extension || !isDefinitionSourceFile(entry.name)) continue
      const name = entry.name.slice(0, -extension.length)
      const file = join(folder, entry.name)
      if (!namePattern.test(name)) {
        throw webhooksErrors.WEBHOOKS_FILE_INVALID({ message: `[vitehub] The webhook ${relative(projectRoot, file)} needs a name of lowercase letters, digits, and dashes, such as t3 or slack-alerts.` })
      }
      const existing = found.get(name)
      if (existing) {
        throw webhooksErrors.WEBHOOKS_FILE_INVALID({ message: `[vitehub] Two files define the webhook ${JSON.stringify(name)}: ${relative(projectRoot, existing.file)} and ${relative(projectRoot, file)}.` })
      }
      found.set(name, { name, file })
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Whether the app has a webhook. */
export function usesWebhooks(options: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return discoverWebhooks(options.projectRoot, options.serverDirs).length > 0
}

/** The module specifiers that the generated code imports. `vite-hub` passes its own subpaths. */
export interface WebhooksImports {
  /** `installWebhooks` and `deliverWebhookWake`. */
  runtime: string
  /** `webhooksOperations`: the operations of the Console, `vitehub webhooks`, and MCP. */
  operations: string
  /** `createDrizzleWebhookStore` and `webhooksSchema`. */
  database: string
  /** The `databases` registry of the app. */
  databases: string
  /** `defineQueue` and `dynamicQueue`. */
  queue: string
  /** The module whose `WebhookRegistry` the generated types extend. */
  types: string
}

const defaultImports: WebhooksImports = {
  runtime: "@vite-hub/webhooks/runtime",
  operations: "@vite-hub/webhooks/operations",
  database: "@vite-hub/webhooks/database",
  databases: "@vite-hub/database/runtime/registry",
  queue: "@vite-hub/queue",
  types: "@vite-hub/webhooks",
}

export interface HubWebhooksOptions {
  imports?: Partial<WebhooksImports>
  /** The app has a ViteHub Database. Webhooks keeps each delivery in its Default Database. */
  database?: boolean
  /** The app has ViteHub Queue. Webhooks delivers through its `vitehub-webhooks` Queue. */
  queue?: boolean
}

/** The files that `hubWebhooks()` writes in `<projectRoot>/.vitehub`. */
export function webhooksGeneratedFiles(projectRoot: string): { directory: string, registry: string, queue: string, plugin: string, types: string } {
  const directory = resolve(projectRoot, ".vitehub/nitro/webhooks")
  return {
    directory,
    registry: join(directory, "registry.mjs"),
    queue: join(directory, "queue.mjs"),
    plugin: join(directory, "plugin.mjs"),
    types: resolve(projectRoot, ".vitehub/webhooks.d.ts"),
  }
}

/** The generated module that installs the webhooks. The Queue handler and the Nitro plugin import it. */
export function renderWebhooksRegistry(webhooks: readonly DiscoveredWebhook[], imports: WebhooksImports): string {
  return [
    `import { installWebhooks, selectDefaultDatabase } from ${JSON.stringify(imports.runtime)}`,
    `import { createDrizzleWebhookStore } from ${JSON.stringify(imports.database)}`,
    `import { databases } from ${JSON.stringify(imports.databases)}`,
    `import { dynamicQueue } from ${JSON.stringify(imports.queue)}`,
    ...webhooks.map((webhook, index) => `import webhook${index} from ${JSON.stringify(webhook.file)}`),
    "",
    "installWebhooks({",
    `  webhooks: { ${webhooks.map((webhook, index) => `${JSON.stringify(webhook.name)}: webhook${index}`).join(", ")} },`,
    "  store: createDrizzleWebhookStore(() => selectDefaultDatabase(databases)),",
    `  wake: (wake, options) => dynamicQueue.send(${JSON.stringify(webhooksQueueName)}, wake, options),`,
    "})",
    "",
  ].join("\n")
}

/** The Queue Definition of `vitehub-webhooks`, which Webhooks contributes to the Queue. */
export function renderWebhooksQueue(imports: WebhooksImports): string {
  return [
    `import { defineQueue } from ${JSON.stringify(imports.queue)}`,
    `import { deliverWebhookWake } from ${JSON.stringify(imports.runtime)}`,
    "import \"./registry.mjs\"",
    "",
    "// A slow receiver must not hold back the deliveries of other webhooks.",
    "export default defineQueue(job => deliverWebhookWake(job.payload), { concurrency: 4 })",
    "",
  ].join("\n")
}

/** The webhook names for `sendWebhook()`, from the files of `server/webhooks/`. */
export function renderWebhooksTypes(file: string, webhooks: readonly DiscoveredWebhook[], typesImport: string): string {
  const entries = webhooks.map((webhook) => {
    const path = relative(dirname(file), webhook.file).replaceAll("\\", "/")
    return `    ${JSON.stringify(webhook.name)}: typeof import(${JSON.stringify(path.startsWith(".") ? path : `./${path}`)}).default`
  })
  return [
    `import ${JSON.stringify(typesImport)}`,
    `declare module ${JSON.stringify(typesImport)} {`,
    "  interface WebhookRegistry {",
    ...entries,
    "  }",
    "}",
    "",
  ].join("\n")
}

function writeIfChanged(file: string, contents: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === contents) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

/** Writes the generated files of the webhooks, or removes them when the app has none. Returns the files. */
function writeWebhooksFiles(projectRoot: string, webhooks: readonly DiscoveredWebhook[], imports: WebhooksImports): ReturnType<typeof webhooksGeneratedFiles> {
  const files = webhooksGeneratedFiles(projectRoot)
  if (!webhooks.length) {
    rmSync(files.directory, { force: true, recursive: true })
    rmSync(files.types, { force: true })
    return files
  }
  writeIfChanged(files.registry, renderWebhooksRegistry(webhooks, imports))
  writeIfChanged(files.queue, renderWebhooksQueue(imports))
  writeIfChanged(files.plugin, "import \"./registry.mjs\"\n\nexport default () => {}\n")
  writeIfChanged(files.types, renderWebhooksTypes(files.types, webhooks, imports.types))
  return files
}

interface ContributionContext {
  projectRoot?: string
  root?: string
  rootDir?: string
  serverDirs?: readonly string[]
}

/**
 * Webhooks in a ViteHub app: each `server/webhooks/<name>.ts` that default-exports `defineWebhook()` gets a name for
 * `sendWebhook()`. Deliveries go to the `vitehub_webhook_deliveries` table of the Default Database and out through the
 * `vitehub-webhooks` Queue, which this plugin contributes. Both features must be on.
 */
export function hubWebhooks(options: HubWebhooksOptions = {}): Plugin & {
  vitehub: {
    databases: (context: ContributionContext) => unknown[]
    queues: (context: ContributionContext) => Array<{ name: string, definition: { module: string }, reason: string }>
    operations: OperationContributions
  }
} {
  const imports: WebhooksImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: readonly string[] | undefined
  const project = (context: ContributionContext) => ({
    projectRoot: projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd(),
    serverDirs: serverDirs ?? context.serverDirs,
  })
  return {
    name: WEBHOOKS_VITE_PLUGIN_NAME,
    enforce: "pre",
    vitehub: {
      // The Console, `vitehub webhooks`, and MCP list, test, flush, cancel, and redeliver through these operations.
      operations: () => usesWebhooks(project({}))
        ? [{ export: "webhooksOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).webhooksOperations, module: imports.operations }]
        : [],
      databases(context) {
        const { projectRoot: root, serverDirs: dirs } = project(context)
        if (!options.database || !usesWebhooks({ projectRoot: root, ...(dirs ? { serverDirs: dirs } : {}) })) return []
        return [{
          definition: { export: "webhooksSchema", module: imports.database },
          dialect: "sqlite",
          tables: webhooksTableNames,
          name: "webhooks",
          reason: "Keeps the deliveries of `server/webhooks/`.",
        }]
      },
      // The Queue may read this before the `config` hook below runs, so it writes the files itself.
      queues(context) {
        const { projectRoot: root, serverDirs: dirs } = project(context)
        const webhooks = discoverWebhooks(root, dirs)
        if (!webhooks.length || !options.queue || !options.database) return []
        const files = writeWebhooksFiles(root, webhooks, imports)
        return [{ name: webhooksQueueName, definition: { module: files.queue }, reason: "Delivers the webhooks of `server/webhooks/`." }]
      },
    },
    config: {
      handler(config: UserConfig) {
        const configuredRoot: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
        const dirs: unknown = Reflect.get(config, VITEHUB_SERVER_DIRS)
        serverDirs = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : undefined
        const root = projectRoot
        const webhooks = discoverWebhooks(root, serverDirs)
        if (webhooks.length) {
          const listed = webhooks.map(webhook => relative(root, webhook.file)).join(", ")
          if (!options.queue) throw webhooksErrors.WEBHOOKS_QUEUE_OFF({ files: listed })
          if (!options.database) throw webhooksErrors.WEBHOOKS_DATABASE_OFF({ files: listed })
        }
        const files = writeWebhooksFiles(root, webhooks, imports)
        if (!webhooks.length) return
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        // The plugin installs the webhooks when the server starts, so `sendWebhook()` works in the first request.
        kit.addPlugin(files.plugin)
        Reflect.set(config, "nitro", kit.config)
      },
    },
  }
}
