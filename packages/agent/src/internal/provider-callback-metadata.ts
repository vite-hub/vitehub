import type { AgentAdapterMetadataContext, AgentAdapterRunContext } from "../types.ts"

type ProviderCallbackContext = Pick<AgentAdapterRunContext, "context">

type WorkspaceMetadata = Pick<AgentAdapterMetadataContext, "fs" | "workspace">

const callbackMetadata = new WeakMap<object, WorkspaceMetadata>()

// Resolver callbacks may inherit metadata without mounting a workspace in the provider run.
export function withProviderCallbackMetadata<T extends ProviderCallbackContext>(context: T, metadata: WorkspaceMetadata): T {
  callbackMetadata.set(context, { fs: metadata.fs, workspace: metadata.workspace })
  return context
}

export function providerCallbackMetadata(context: ProviderCallbackContext): WorkspaceMetadata | undefined {
  return callbackMetadata.get(context)
}

/** Give a copied invocation context the Workspace metadata of the context it copies. */
export function copyProviderCallbackMetadata<T extends ProviderCallbackContext>(source: ProviderCallbackContext, copy: T): T {
  const metadata = callbackMetadata.get(source)
  if (metadata) callbackMetadata.set(copy, metadata)
  return copy
}
