import type { AgentRegistry } from "../types.ts"

/** The generated `metadata` export: the identity of each discovered Agent. */
export type AgentRegistryMetadata = Record<string, { name: string, workspace?: string }>

// Vite resolves `#vitehub/agent/registry` to the generated registry. Node resolves it here through the package
// `imports` field, which happens in `vite dev` because ViteHub loads this package without Vite there.
let registry: AgentRegistry = {}
let metadata: AgentRegistryMetadata = {}

export { metadata, registry as default }

/** Hands the generated registry to the Agent package. The `vite dev` Nitro plugin calls this at startup and after each reload. */
export function installAgentRegistry(module: { default: AgentRegistry, metadata: AgentRegistryMetadata }): void {
  registry = module.default
  metadata = module.metadata
}
