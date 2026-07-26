export { defineSource, defineSources } from "./core/define.ts"
export {
  clearSources,
  getRegisteredSource,
  registerSource,
  registerSources,
  useSource,
} from "./core/registry.ts"
export type * from "./core/types.ts"
export type { SourceErrorCode } from "./core/errors.ts"
export {
  custom,
  file,
  github,
  glob,
  markdown,
  mcpResources,
} from "./sources/index.ts"
export type {
  FileSourceInlineOptions,
  FileSourceOptions,
  FileSourcePathOptions,
  GitHubSourceOptions,
  GlobSourceOptions,
  McpResourceContent,
  McpResourceDescriptor,
  McpResourcesClient,
  McpResourcesClientConfig,
  McpResourcesRequestOptions,
  McpResourcesServer,
  McpResourcesSourceOptions,
  McpResourcesTransportConfig,
} from "./sources/index.ts"
