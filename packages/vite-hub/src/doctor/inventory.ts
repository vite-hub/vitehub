import { existsSync, readdirSync, readFileSync } from "node:fs"

import { relative, resolve } from "node:path"
import * as v from "valibot"
import type { ProjectInventoryContributor, RuleContext } from "vite-doctor/extension"

/** Name of the ViteHub Project Inventory contribution, read by rules through `viteHubInventory()`. */
export const inventoryName = "vite-hub"

export const definitionKinds = ["agent", "browser", "channel", "connection", "database", "queue", "realtime", "sandboxTask", "schedule", "workflow"] as const
export type DefinitionKind = typeof definitionKinds[number]

const definitionSchema = v.object({
  name: v.string(),
  file: v.string(),
  steps: v.optional(v.array(v.string())),
  manual: v.optional(v.boolean()),
})
const inventorySchema = v.object({
  /** Definitions that each owner package discovers. A kind is missing when its discovery failed. */
  definitions: v.record(v.string(), v.array(definitionSchema)),
  /** Server Env facts from the generated `.vitehub/env/description.mjs`. Missing before the first dev or build run. */
  env: v.optional(v.object({ secret: v.array(v.string()), provider: v.array(v.string()) })),
})
export type ViteHubInventory = {
  definitions: Partial<Record<DefinitionKind, DiscoveredFile[]>>
  env?: { secret: string[], provider: string[] }
}
export type DiscoveredFile = {
  name: string
  file: string
  /** Step files of a folder Workflow, relative to the project root. */
  steps?: string[]
  /** Whether a Schedule Definition sets `manual: true`. */
  manual?: boolean
}

const emptyInventory: ViteHubInventory = { definitions: {} }

export function viteHubInventory(ctx: RuleContext): ViteHubInventory {
  const value = ctx.project.inventory?.[inventoryName]
  return v.is(inventorySchema, value) ? value : emptyInventory
}

/** The Definition kind and name for the current file, when an owner package discovers it. */
export function discoveredDefinition(ctx: RuleContext): { kind: DefinitionKind, name: string } | undefined {
  const { definitions } = viteHubInventory(ctx)
  for (const kind of definitionKinds) {
    const found = definitions[kind]?.find(definition => definition.file === ctx.file.relativePath)
    if (found) return { kind, name: found.name }
  }
}

type Discovered = { name: string, handler: string, steps?: readonly string[], manual?: boolean }
type Discover = (root: string, serverDirs: string[]) => Promise<readonly Discovered[]>

// Each owner package owns its discovery rules. Calling them keeps Doctor in step with the build.
const discoverers: Record<DefinitionKind, Discover> = {
  agent: async (root, serverDirs) => (await import("@vite-hub/agent/vite")).listAgentDefinitionFiles(root, serverDirs),
  browser: async (root, serverDirs) => (await import("@vite-hub/browser/vite")).discoverBrowserDefinitions({ rootDir: root, serverDirs }),
  channel: async (root, serverDirs) => (await import("@vite-hub/channels/vite")).discoverChannelDefinitions({ rootDir: root, serverDirs }),
  connection: async (root, serverDirs) => (await import("@vite-hub/connections/vite")).discoverConnectionDefinitions({ rootDir: root, serverDirs }),
  database: async (root, serverDirs) => (await import("@vite-hub/database/config")).discoverDatabaseDefinitions(root, { serverDirs }),
  queue: async (root, serverDirs) => (await import("@vite-hub/queue/vite")).discoverQueueDefinitions({ rootDir: root, serverDirs }),
  realtime: async (root, serverDirs) => (await import("@vite-hub/realtime/vite")).discoverRealtimeDefinitions(root, serverDirs),
  sandboxTask: async root => (await import("@vite-hub/sandbox/task/vite")).discoverSandboxTaskDefinitions({ rootDir: root }),
  schedule: async (root, serverDirs) => (await import("@vite-hub/schedule/vite")).discoverScheduleDefinitions({ rootDir: root, serverDirs }),
  workflow: async (root, serverDirs) => (await import("@vite-hub/workflow/vite")).discoverWorkflowDefinitions({ rootDir: root, serverDirs }),
}

/** `server/` and the `server/` directory of each Nuxt layer under `layers/`. */
function serverDirsOf(root: string): string[] {
  const layers = resolve(root, "layers")
  const layerDirs = existsSync(layers)
    ? readdirSync(layers, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => resolve(layers, entry.name, "server"))
    : []
  return [resolve(root, "server"), ...layerDirs.filter(dir => existsSync(dir))]
}

const describeSchema = v.object({
  entries: v.array(v.object({ path: v.optional(v.string()), source: v.string(), secret: v.boolean() })),
})

/** Reads Server Env paths from the generated description module, as paths below `env.server`. */
function readEnvFacts(root: string): ViteHubInventory["env"] {
  const file = resolve(root, ".vitehub/env/description.mjs")
  if (!existsSync(file)) return
  const encoded = /JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(readFileSync(file, "utf8"))?.[1]
  if (!encoded) return
  const description: unknown = JSON.parse(JSON.parse(encoded))
  if (!v.is(describeSchema, description)) return
  const paths = (predicate: (entry: v.InferOutput<typeof describeSchema>["entries"][number]) => boolean) => description.entries
    .filter(predicate)
    .flatMap(entry => entry.path?.startsWith("env.server.") ? [entry.path.slice("env.server.".length)] : [])
  return { secret: paths(entry => entry.secret), provider: paths(entry => entry.source === "provider") }
}

export const viteHubInventoryContributor: ProjectInventoryContributor = {
  name: inventoryName,
  async contribute(project) {
    const root = project.root
    const serverDirs = serverDirsOf(root)
    const definitions: ViteHubInventory["definitions"] = {}
    await Promise.all(definitionKinds.map(async (kind) => {
      try {
        const found = await discoverers[kind](root, serverDirs)
        const path = (file: string) => relative(root, file).replaceAll("\\", "/")
        definitions[kind] = found.map(definition => ({
          name: definition.name,
          file: path(definition.handler),
          ...(definition.steps?.length ? { steps: definition.steps.map(path) } : {}),
          ...(definition.manual === undefined ? {} : { manual: definition.manual }),
        }))
      }
      catch {
        // Discovery reports its own errors during dev and build. Rules skip a kind that Doctor cannot read.
      }
    }))
    let env: ViteHubInventory["env"]
    try {
      env = readEnvFacts(root)
    }
    catch {
      env = undefined
    }
    return { definitions, ...(env ? { env } : {}) } satisfies ViteHubInventory
  },
}
