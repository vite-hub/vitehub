import type { AgentAdapterMetadataContext } from "../types.ts"

type WorkspaceMetadata = Pick<AgentAdapterMetadataContext, "fs" | "workspace">

const callbackMetadata = new WeakMap<object, WorkspaceMetadata>()

// Resolver callbacks may inherit metadata without mounting a workspace in the provider run.
export function withProviderCallbackMetadata<T extends object>(context: T, metadata: WorkspaceMetadata): T {
  callbackMetadata.set(context, { fs: metadata.fs, workspace: metadata.workspace })
  return context
}

export function providerCallbackMetadata(context: object): WorkspaceMetadata | undefined {
  return callbackMetadata.get(context)
}
