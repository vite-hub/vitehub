export { defineWorkspace } from "./core/define.ts"
export { createWorkspace } from "./core/workspace.ts"
export { sourceIgnores } from "@vite-hub/source"
export {
  custom,
  file,
  github,
  glob,
  markdown,
  mcpResources,
  url,
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
export { isWorkspaceConflict } from "./core/errors.ts"
export type { WorkspaceErrorCode } from "./core/errors.ts"
export { isWorkspaceName } from "./core/registry.ts"
export { registerWorkspacePlugin } from "./core/plugins.ts"
export { useWorkspace } from "./core/use-tools.ts"
export { useWorkspaceFiles } from "./core/use.ts"
export type * from "./core/use.ts"
export type * from "./core/types.ts"
