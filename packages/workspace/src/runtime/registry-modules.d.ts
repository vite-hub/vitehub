declare module "#vitehub-workspace-registry" {
  import type { WorkspaceRegistry } from "../core/registry.ts"
  const registry: WorkspaceRegistry
  export default registry
}

declare module "#vitehub-workspace-assets-registry" {
  import type { WorkspaceAssetsRegistry } from "../core/types.ts"
  const registry: WorkspaceAssetsRegistry
  export default registry
}
