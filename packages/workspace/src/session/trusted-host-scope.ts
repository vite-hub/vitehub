import { openWorkspaceResourceScope } from "./resource-scope.ts"

import type { WorkspaceResourceScope } from "./resource-scope.ts"

export type TrustedHostWorkspaceScope<Resource, Setup> = WorkspaceResourceScope<Resource, Setup>

export function openTrustedHostWorkspaceScope<Resource, Setup>(
  acquire: () => Promise<Resource>,
  setup: (resource: Resource) => Promise<Setup>,
  release: (resource: Resource) => Promise<void>,
): Promise<TrustedHostWorkspaceScope<Resource, Setup>> {
  return openWorkspaceResourceScope({
    acquire,
    operation: "Workspace.TrustedHost",
    release,
    setup,
  })
}
