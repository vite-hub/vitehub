export { defineWorkspace } from "./core/define.ts"
export { createWorkspace } from "./core/workspace.ts"
export { sourceIgnores } from "@vite-hub/source"
export {
  custom,
  fetch,
  file,
  github,
  glob,
  markdown,
  mcpResources,
} from "./sources/index.ts"
export * as source from "./sources/index.ts"
export type {
  FetchSourceInput,
  FetchSourceOptions,
  FetchSourceRequest,
  FetchSourceRequestOptions,
  FetchSourceResolver,
  FileSourceOptions,
  GitHubSourceInput,
  GitHubSourceOptions,
  GitHubSourceResolver,
  GlobSourceOptions,
  McpResourceContent,
  McpResourceDescriptor,
  McpResourcesClient,
  McpResourcesClientConfig,
  McpResourcesRequestOptions,
  McpResourcesServer,
  McpResourcesSourceOptions,
} from "./sources/index.ts"
export { createWorkspaceTools } from "./ai.ts"
export type * from "./ai.ts"
export { resolveWorkspaceAutoCommit } from "./core/rules.ts"
export { isWorkspaceConflict } from "./core/errors.ts"
export { normalizeSafeWorkspacePath } from "./core/path.ts"
export { invalidateWorkspaceStore } from "./runtime/state.ts"
export { resolveWorkspaceStoreTarget } from "./storage/target.ts"
export type { WorkspaceStoreTarget } from "./storage/target.ts"
export type { WorkspaceErrorCode } from "./core/errors.ts"
export { resolveRegisteredWorkspaceDefinition } from "./core/registry.ts"
export { useWorkspace } from "./core/use.ts"
export type * from "./core/use.ts"
export type * from "./core/types.ts"
