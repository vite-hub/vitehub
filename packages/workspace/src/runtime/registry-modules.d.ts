declare module "#vitehub-workspace-registry" {
  import type { WorkspaceRegistry } from "../registry.ts"
  const registry: WorkspaceRegistry
  export default registry
}

declare module "#vitehub-workspace-assets-registry" {
  import type { WorkspaceAssetsRegistry } from "../types.ts"
  const registry: WorkspaceAssetsRegistry
  export default registry
}
