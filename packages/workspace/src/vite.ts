export { createWorkspaceNitroConfig, hubWorkspace } from "./hosts/vite/plugin.ts"
export { discoverViteWorkspaceDefinitions } from "./build/discovery.ts"
export type {
  NitroConfig,
  WorkspaceNitroConfigOptions,
  WorkspaceVitePlugin,
  WorkspaceVitePluginAPI,
} from "./hosts/vite/plugin.ts"
export type { DiscoveredWorkspaceDefinition } from "./build/discovery.ts"
