import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

import { normalizeWorkspaceDefinition } from "./core/registry.ts"
import { isWorkspaceStore, resolveWorkspaceDefinitionStore } from "./storage/provider.ts"

import type { ResolvedWorkspaceModuleOptions, WorkspaceDefinitionInput } from "./core/types.ts"

/** What the build passes to `workspaceDurability()`. */
export interface WorkspaceDurabilityInput {
  /** The app passes its own `WorkspaceStore` object. */
  custom?: true
  /** The build chose the store, so `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` can switch it to Vercel Blob at boot. */
  inferred?: boolean
  provider?: string
  /** The folder of the local store, relative to the project. */
  root?: string
}

const sharedProviders: Record<string, string> = {
  "cloudflare-artifacts": "Cloudflare Artifacts.",
  "github": "A GitHub repository.",
  "vercel-blob": "Vercel Blob.",
}

const fix = "Use a shared Workspace store, such as `workspace: { store: { provider: \"github\" } }` or Vercel Blob."

/** The durability of Workspace files, from the store provider. */
export function workspaceDurability(input: WorkspaceDurabilityInput, { env }: DurabilityContext): Durability[] {
  if (input.custom) {
    return [{ primitive: "workspace", store: "custom", scope: "shared", reason: "A custom Workspace store. ViteHub cannot see where it keeps files, so check that every instance reads the same store." }]
  }
  const provider = input.inferred && input.provider === "local" && (env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim()) ? "vercel-blob" : input.provider ?? "local"
  const shared = sharedProviders[provider]
  if (shared) return [{ primitive: "workspace", store: provider, scope: "shared", reason: shared }]
  if (provider === "memory") return [{ primitive: "workspace", store: "memory", scope: "process", reason: "Workspace files live in the memory of this process.", fix }]
  return [{ primitive: "workspace", store: "local", scope: "host", reason: `Files in ${input.root ?? ".vitehub/workspaces"} on this host.`, fix }]
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
    const store = resolveWorkspaceDefinitionStore(definition, config, { env: context.env, hosting: context.env.VITEHUB_HOSTING })
    const report = workspaceDurability(isWorkspaceStore(store) ? { custom: true } : {
      provider: store?.provider,
      root: store && "root" in store && typeof store.root === "string" ? store.root : config ? `${config.root}/${name}` : undefined,
    }, context)
    return report.map(entry => ({ ...entry, ...(entries.length ? { name } : {}) }))
  })
}
