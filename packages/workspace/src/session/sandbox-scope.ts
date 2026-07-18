import { openWorkspaceResourceScope } from "./resource-scope.ts"

import type { WorkspaceResourceScope } from "./resource-scope.ts"

interface SandboxResource {
  readonly provider: string
  stop(): Promise<void>
}

export type SandboxWorkspaceScope<Resource extends SandboxResource, Setup> = WorkspaceResourceScope<Resource, Setup>

export function openSandboxWorkspaceScope<Resource extends SandboxResource, Setup>(
  acquire: () => Promise<Resource>,
  setup: (resource: Resource) => Promise<Setup>,
): Promise<SandboxWorkspaceScope<Resource, Setup>> {
  return openWorkspaceResourceScope({
    acquire,
    operation: "Workspace.Sandbox",
    release: async (sandbox) => {
      if (sandbox.provider === "vercel") await sandbox.stop()
    },
    setup,
  })
}
