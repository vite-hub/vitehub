export { defineWorkspace } from "./core/define.ts"
export {
  custom,
  fetch,
  file,
  github,
  glob,
  markdown,
  mcpResources,
} from "./sources/index.ts"
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
export {
  createWorkspaceSourceResolutionFacade,
  hasWorkspaceSourceResolvers,
  resolveWorkspaceSources,
} from "./sources/resolution.ts"
export {
  getWorkspaceSourceRequestDescriptor,
  isWorkspaceSourceRequestOnly,
  workspaceSourceRequestDescriptorPath,
} from "./sources/config.ts"
export { markLiveWorkspaceSource } from "./sources/live.ts"
export {
  attachWorkspaceSourceRequestExecution,
  getWorkspaceSourceRequestExecution,
} from "./sources/request-execution.ts"
export {
  prepareHarnessWorkspaceSession,
} from "./session/harness.ts"
export type {
  HarnessSandboxSession,
  HarnessWorkspaceSession,
  PrepareHarnessWorkspaceSessionOptions,
} from "./session/harness.ts"
export type {
  WorkspaceSourceResolutionFacade,
  WorkspaceSourceResolutionOptions,
} from "./sources/resolution.ts"
export type * from "./ai.ts"
export { resolveWorkspaceAutoCommit } from "./core/rules.ts"
export { resolveRegisteredWorkspaceDefinition } from "./core/registry.ts"
export { useWorkspace } from "./core/use.ts"
export type * from "./core/use.ts"
export type * from "./core/types.ts"
