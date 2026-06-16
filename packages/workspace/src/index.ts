export { defineWorkspace } from "./core/define.ts"
export * as source from "./sources/index.ts"
export type * from "./sources/index.ts"
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
export {
  attachWorkspaceSourceRequestExecution,
  getWorkspaceSourceRequestExecution,
} from "./sources/request-execution.ts"
export type {
  WorkspaceSourceResolutionFacade,
  WorkspaceSourceResolutionOptions,
} from "./sources/resolution.ts"
export type * from "./ai.ts"
export { resolveWorkspaceAutoCommit } from "./core/rules.ts"
export { useWorkspace } from "./core/use.ts"
export type * from "./core/use.ts"
export type * from "./core/types.ts"
