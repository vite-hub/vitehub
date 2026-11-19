import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { isDefinitionSourceFile } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { isPlainObject } from "@vite-hub/internal/object"

import { webhooksErrors } from "./errors.ts"
import { webhooksQueueName } from "./queue-name.ts"
import { webhookEndpointsTableNames, webhooksTableNames } from "./table-names.ts"

import type { DeploymentEnvContribution } from "@vite-hub/internal/build/deployment-plan-output"
import type { ContributionContext } from "@vite-hub/internal/contributions"
import type { OperationContributions } from "@vite-hub/internal/operations"
import type { ConfigEnv, Plugin, UserConfig } from "vite"

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

/**
 * What another package's Vite plugin puts in `vitehub.webhooks` to use Webhooks with no `server/webhooks/` files, such
 * as Comments with `send: true`. A function gets the project roots and the sibling plugins, and returns `undefined` when
 * its feature is off.
 *
 * ```ts
 * const plugin = { name: "my-feature", vitehub: { webhooks: { memberEndpoints: true, reason: "Sends to each member's agent." } } }
 * ```
 */
export interface WebhooksUse {
  /** Turns on member endpoints: their table, `createMemberEndpoint()`, and `sendToMemberEndpoint()`. No Queue needed. */
  memberEndpoints: true
  /** Why the plugin uses them. Build errors name it. */
  reason: string
}

/** The `vitehub.webhooks` field of a plugin. */
export type WebhooksUseSource = WebhooksUse | ((context: ContributionContext) => WebhooksUse | undefined | Promise<WebhooksUse | undefined>)

/** The plugins that use member endpoints, as `<plugin>: <reason>`. An entry of the wrong shape throws. */
export async function collectWebhooksUses(plugins: readonly unknown[] | undefined, context: ContributionContext): Promise<string[]> {
  const candidates = await flattenPluginOptions(plugins)
  const uses: string[] = []
  for (const plugin of candidates) {
    const metadata: unknown = Object.hasOwn(plugin, "vitehub") ? Reflect.get(plugin, "vitehub") : undefined
    if (!isPlainObject(metadata) || !Object.hasOwn(metadata, "webhooks")) continue
    const name: unknown = Reflect.get(plugin, "name")
    const contributor = typeof name === "string" && name ? name : "unnamed plugin"
    const source = metadata.webhooks
    const use: unknown = typeof source === "function" ? await Reflect.apply(source, undefined, [{ ...context, plugins: candidates }]) : source
    if (use === undefined) continue
    if (!isPlainObject(use) || use.memberEndpoints !== true || typeof use.reason !== "string" || !use.reason) {
      throw webhooksErrors.WEBHOOKS_CONTRIBUTION_INVALID({ plugin: JSON.stringify(contributor) })
    }
    uses.push(`${contributor}: ${use.reason}`)
  }
  return uses
}

/** The module specifiers that the generated code imports. `vite-hub` passes its own subpaths. */
export interface WebhooksImports {
  /** `installWebhooks` and `deliverWebhookWake`. */
  runtime: string
  /** `webhooksOperations`: the operations of the Console, `vitehub webhooks`, and MCP. */
  operations: string
  /** `createDrizzleWebhookStore`, `createDrizzleWebhookEndpointStore`, and the schemas. */
  database: string
  /** The Database registry of the app, with `useDatabase()`. */
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

/** What the generated registry installs besides the webhooks of `server/webhooks/`. */
export interface WebhooksRegistryFeatures {
  /** Wake the `vitehub-webhooks` Queue. Off for an app with member endpoints and no Queue. */
  queue: boolean
  /** Install the member endpoint store. */
  memberEndpoints: boolean
}

/** The generated module that installs the webhooks. The Queue handler and the Nitro plugin import it. */
export function renderWebhooksRegistry(webhooks: readonly DiscoveredWebhook[], imports: WebhooksImports, features: WebhooksRegistryFeatures = { queue: true, memberEndpoints: false }): string {
  const stores = features.memberEndpoints ? "createDrizzleWebhookEndpointStore, createDrizzleWebhookStore" : "createDrizzleWebhookStore"
  return [
    `import { installWebhooks, selectDefaultDatabase } from ${JSON.stringify(imports.runtime)}`,
    `import { ${stores} } from ${JSON.stringify(imports.database)}`,
    `import { useDatabase } from ${JSON.stringify(imports.databases)}`,
    ...features.queue ? [`import { dynamicQueue } from ${JSON.stringify(imports.queue)}`] : [],
    ...webhooks.map((webhook, index) => `import webhook${index} from ${JSON.stringify(webhook.file)}`),
    "",
    "const db = () => selectDefaultDatabase(() => useDatabase())",
    "",
    "installWebhooks({",
    `  webhooks: { ${webhooks.map((webhook, index) => `${JSON.stringify(webhook.name)}: webhook${index}`).join(", ")} },`,
    "  store: createDrizzleWebhookStore(db),",
    ...features.memberEndpoints ? ["  endpoints: createDrizzleWebhookEndpointStore(db),"] : [],
    ...features.queue ? [`  wake: (wake, options) => dynamicQueue.send(${JSON.stringify(webhooksQueueName)}, wake, options),`] : [],
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
    "export default defineQueue({ handler: ({ payload }) => deliverWebhookWake(payload), concurrency: 4 })",
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

/** Writes the generated files of the webhooks, or removes them when the app uses no webhooks. Returns the files. */
function writeWebhooksFiles(projectRoot: string, webhooks: readonly DiscoveredWebhook[], imports: WebhooksImports, features: WebhooksRegistryFeatures): ReturnType<typeof webhooksGeneratedFiles> {
  const files = webhooksGeneratedFiles(projectRoot)
  if (!webhooks.length && !features.memberEndpoints) {
    rmSync(files.directory, { force: true, recursive: true })
    rmSync(files.types, { force: true })
    return files
  }
  writeIfChanged(files.registry, renderWebhooksRegistry(webhooks, imports, features))
  if (features.queue) writeIfChanged(files.queue, renderWebhooksQueue(imports))
  else rmSync(files.queue, { force: true })
  writeIfChanged(files.plugin, "import \"./registry.mjs\"\n\nexport default () => {}\n")
  writeIfChanged(files.types, renderWebhooksTypes(files.types, webhooks, imports.types))
  return files
}

/** The path of the key that `vite dev` generates when the app sets no `VITEHUB_WEBHOOKS_KEY`. */
export function webhooksDevelopmentKeyFile(projectRoot: string): string {
  return resolve(projectRoot, ".vitehub/data/webhooks-key")
}

/**
 * In `vite dev`, a missing `VITEHUB_WEBHOOKS_KEY` reads the key file of the project, or generates it, so member
 * endpoints survive a restart. A build never generates a key.
 */
async function useDevelopmentKey(projectRoot: string, envDir: string, mode: string): Promise<void> {
  const { loadEnv } = await import("vite")
  if (loadEnv(mode, envDir, "VITEHUB_WEBHOOKS_KEY").VITEHUB_WEBHOOKS_KEY) return
  const file = webhooksDevelopmentKeyFile(projectRoot)
  let key = await readFile(file, "utf8").then(value => value.trim(), () => "")
  if (!key) {
    const generated = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    await mkdir(dirname(file), { recursive: true })
    // `wx` keeps the key of a dev server that wrote it first.
    key = await writeFile(file, `${generated}\n`, { flag: "wx", mode: 0o600 }).then(() => generated, async () => (await readFile(file, "utf8")).trim())
  }
  process.env.VITEHUB_WEBHOOKS_KEY = key
}

interface PluginContext {
  projectRoot?: string
  root?: string
  rootDir?: string
  serverDirs?: readonly string[]
  plugins?: readonly unknown[]
}

/**
 * Webhooks in a ViteHub app: each `server/webhooks/<name>.ts` that default-exports `defineWebhook()` gets a name for
 * `sendWebhook()`. Deliveries go to the `vitehub_webhook_deliveries` table of the Default Database and out through the
 * `vitehub-webhooks` Queue, which this plugin contributes. Both features must be on.
 *
 * A sibling plugin that sets `vitehub.webhooks` (see `WebhooksUse`) turns on member endpoints, with no files. They need
 * the Database. With Queue, failed member deliveries are tried again through it.
 */
export function hubWebhooks(options: HubWebhooksOptions = {}): Plugin & {
  api: { deploymentEnv: DeploymentEnvContribution }
  vitehub: {
    databases: (context: PluginContext) => Promise<unknown[]>
    queues: (context: PluginContext) => Promise<Array<{ name: string, definition: { module: string }, reason: string }>>
    operations: OperationContributions
  }
} {
  const imports: WebhooksImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: readonly string[] | undefined
  // Set by the `config` hook. The deployment manifest reads it after the build resolves its config.
  let memberEndpointsOn = false
  const project = (context: PluginContext) => ({
    projectRoot: projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd(),
    serverDirs: serverDirs ?? context.serverDirs,
  })
  /** The files of `server/webhooks/` and the plugins that use member endpoints. */
  const usage = async (context: PluginContext) => {
    const { projectRoot: root, serverDirs: dirs } = project(context)
    const webhooks = discoverWebhooks(root, dirs)
    const uses = await collectWebhooksUses(context.plugins, { root: context.root ?? root, projectRoot: root, ...dirs ? { serverDirs: dirs } : {} })
    return { root, webhooks, uses, features: { queue: Boolean(options.queue && options.database), memberEndpoints: uses.length > 0 } }
  }
  return {
    name: WEBHOOKS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      deploymentEnv: () => memberEndpointsOn
        ? [{ names: ["VITEHUB_WEBHOOKS_KEY"], required: true, secret: true, hasDefault: false, owners: ["webhooks"] }]
        : [],
    },
    vitehub: {
      // The Console, `vitehub webhooks`, and MCP list, test, flush, cancel, and redeliver through these operations.
      operations: () => usesWebhooks(project({}))
        ? [{ export: "webhooksOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).webhooksOperations, module: imports.operations }]
        : [],
      async databases(context) {
        const { webhooks, features } = await usage(context)
        if (!options.database || (!webhooks.length && !features.memberEndpoints)) return []
        return [
          {
            definition: { export: "webhooksSchema", module: imports.database },
            dialect: "sqlite",
            tables: webhooksTableNames,
            name: "webhooks",
            reason: "Keeps the deliveries of `server/webhooks/` and of member endpoints.",
          },
          ...features.memberEndpoints
            ? [{
                definition: { export: "webhookEndpointsSchema", module: imports.database },
                dialect: "sqlite",
                tables: webhookEndpointsTableNames,
                name: "webhook-endpoints",
                reason: "Keeps the endpoint of each member, with the URL and secret sealed.",
              }]
            : [],
        ]
      },
      // The Queue may read this before the `config` hook below runs, so it writes the files itself.
      async queues(context) {
        const { root, webhooks, features } = await usage(context)
        if ((!webhooks.length && !features.memberEndpoints) || !features.queue) return []
        const files = writeWebhooksFiles(root, webhooks, imports, features)
        return [{ name: webhooksQueueName, definition: { module: files.queue }, reason: "Delivers the webhooks of `server/webhooks/` and retries member deliveries." }]
      },
    },
    config: {
      async handler(config: UserConfig, env: ConfigEnv) {
        const configuredRoot: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
        const dirs: unknown = Reflect.get(config, VITEHUB_SERVER_DIRS)
        serverDirs = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : undefined
        const { root, webhooks, uses, features } = await usage({ root: resolve(config.root ?? process.cwd()), plugins: config.plugins })
        memberEndpointsOn = features.memberEndpoints
        const listed = webhooks.map(webhook => relative(root, webhook.file))
        if (listed.length && !options.queue) throw webhooksErrors.WEBHOOKS_QUEUE_OFF({ files: listed.join(", ") })
        if ((listed.length || uses.length) && !options.database) throw webhooksErrors.WEBHOOKS_DATABASE_OFF({ users: [...listed, ...uses].join(", ") })
        const files = writeWebhooksFiles(root, webhooks, imports, features)
        if (!webhooks.length && !features.memberEndpoints) return
        if (features.memberEndpoints && env.command === "serve") await useDevelopmentKey(root, resolve(root, config.envDir === false ? "." : config.envDir ?? "."), env.mode)
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        // The plugin installs the webhooks when the server starts, so `sendWebhook()` works in the first request.
        kit.addPlugin(files.plugin)
        Reflect.set(config, "nitro", kit.config)
      },
    },
  }
}

export { webhooksConsoleSection } from "./console.ts"
