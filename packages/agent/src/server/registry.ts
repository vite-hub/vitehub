// Keep registry initialization independent of server internals and their registry import.
export { resetPublicUrlAgentNames } from "@vite-hub/runtime"
export { installAgentServerEnv } from "../internal/builtin-env.ts"
export { installAgentKV } from "../internal/optional-kv.ts"
export { installAgentRegistry } from "../runtime/registry.ts"
export type { AgentRegistryMetadata } from "../runtime/registry.ts"
