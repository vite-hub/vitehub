import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

import { normalizeWorkspaceDefinition, workspaceRegistryLoadError } from "./core/registry.ts"
import { readBlobDatabaseSources } from "./storage/blob-database-sources.ts"
import { isWorkspaceStore, resolveWorkspaceDefinitionStore } from "./storage/provider.ts"

import type { BlobDatabaseSources } from "./storage/blob-database-sources.ts"

import type { ResolvedWorkspaceModuleOptions, WorkspaceDefinitionInput } from "./core/types.ts"

/** What the build passes to `workspaceDurability()`. */
export interface WorkspaceDurabilityInput {
  /** The app passes its own `WorkspaceStore` object. */
  custom?: true
  /** The app passes a Blob + Database Store. Each name is `undefined` when the app passed an object. */
  blobDatabase?: BlobDatabaseSources
  /** The build chose the store, so `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` can switch it to Vercel Blob at boot. */
  inferred?: boolean
  driver?: string
  /** The folder of the local store, relative to the project. */
  root?: string
}

const sharedDrivers: Record<string, string> = {
  "cloudflare": "Cloudflare Artifacts.",
  "github": "A GitHub repository.",
  "vercel": "Vercel Blob.",
}

const fix = "Use a shared Workspace store, such as `workspace: { store: { driver: \"github\" } }` or Vercel Blob."

const blobDatabaseFix = "Pass the names of a shared Blob store and a shared Database, such as `createBlobDatabaseWorkspaceStore({ blob: \"default\", database: \"history\", workspace: \"docs\" })`."
const scopeOrder: Durability["scope"][] = ["process", "host", "shared"]

function blobDatabaseDurability({ blob, database }: BlobDatabaseSources, context: DurabilityContext): Durability {
  if (blob === undefined || database === undefined) {
    return { primitive: "workspace", store: "blob-database", scope: "shared", reason: "A Blob + Database Store that got objects, not names. ViteHub cannot see which Blob store and Database it uses, so check that every instance uses the same shared ones, or pass their names." }
  }
  const parts = [
    { label: `the ${blob} Blob store`, report: context.find("blob", blob) },
    { label: `the ${database} Database`, report: context.find("database", database) },
  ]
  const off = parts.find(part => !part.report)
  if (off) return { primitive: "workspace", store: "blob-database", scope: "process", reason: `The Blob + Database Store uses ${off.label}, which is off.`, fix: blobDatabaseFix }
  const reports = parts.map(part => part.report!)
  const worst = reports.reduce((left, right) => scopeOrder.indexOf(right.scope) < scopeOrder.indexOf(left.scope) ? right : left)
  return {
    primitive: "workspace",
    store: `blob-database (${reports.map(report => report.store).join(", ")})`,
    scope: worst.scope,
    reason: `File bytes in ${parts[0]!.label} and history in ${parts[1]!.label}. ${reports.map(report => report.reason).join(" ")}`,
    ...(worst.scope === "shared" ? {} : { fix: worst.fix ?? blobDatabaseFix }),
  }
}

/** The durability of Workspace files, from the store driver. */
export function workspaceDurability(input: WorkspaceDurabilityInput, context: DurabilityContext): Durability[] {
  const { env } = context
  if (input.blobDatabase) return [blobDatabaseDurability(input.blobDatabase, context)]
  if (input.custom) {
    return [{ primitive: "workspace", store: "custom", scope: "shared", reason: "A custom Workspace store. ViteHub cannot see where it keeps files, so check that every instance reads the same store." }]
  }
  const driver = input.inferred && input.driver === "local" && (env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim()) ? "vercel" : input.driver ?? "local"
  const shared = sharedDrivers[driver]
  if (shared) return [{ primitive: "workspace", store: driver, scope: "shared", reason: shared }]
  if (driver === "memory") return [{ primitive: "workspace", store: "memory", scope: "process", reason: "Workspace files live in the memory of this process.", fix }]
  return [{ primitive: "workspace", store: "local", scope: "host", reason: `Files in ${input.root ?? ".vitehub/workspaces"} on this host.`, fix }]
}

/** Read the Definitions of the eager generated registry, whose loaders return the module without a Promise. */
export function workspaceRegistryDefinitions(
  registry: Record<string, () => { default?: WorkspaceDefinitionInput }>,
): Record<string, WorkspaceDefinitionInput | undefined> {
  return Object.fromEntries(Object.entries(registry).map(([name, load]) => {
    try {
      return [name, load().default]
    }
    catch (error) {
      throw workspaceRegistryLoadError(name, error)
    }
  }))
}

/** Read evaluated Definitions, including Agent Workspace options, with the runtime's store precedence. */
export function workspaceDefinitionsDurability(
  definitions: Record<string, WorkspaceDefinitionInput | undefined>,
  config: false | ResolvedWorkspaceModuleOptions,
  context: DurabilityContext,
): Durability[] {
  const entries = Object.entries(definitions)
  return (entries.length ? entries : [["default", {}] as const]).flatMap(([name, input]) => {
    const definition = normalizeWorkspaceDefinition(name, input)
    const store = resolveWorkspaceDefinitionStore(definition, config, { env: context.env, hosting: context.env.VITEHUB_HOST })
    const blobDatabase = readBlobDatabaseSources(store)
    const report = workspaceDurability(blobDatabase ? { blobDatabase } : isWorkspaceStore(store) ? { custom: true } : {
      driver: store?.driver,
      root: store && "root" in store && typeof store.root === "string" ? store.root : config ? `${config.root}/${name}` : undefined,
    }, context)
    return report.map(entry => ({ ...entry, ...(entries.length ? { name } : {}) }))
  })
}
