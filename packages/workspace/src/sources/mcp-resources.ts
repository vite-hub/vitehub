import { mcpResources as createMcpResourcesSource } from "@vite-hub/source"

import type { WorkspaceSource } from "../core/types.ts"
import type { McpResourcesSourceOptions as SourcePackageMcpResourcesSourceOptions } from "@vite-hub/source"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "validate">

export interface McpResourcesSourceOptions<TKey extends string = string>
  extends Omit<SourcePackageMcpResourcesSourceOptions<TKey>, "cache">, SourceRuntimeOptions {}

export function mcpResources<const TKey extends string = string>(options: McpResourcesSourceOptions<TKey>): WorkspaceSource {
  const baseSource = createMcpResourcesSource({
    ...options,
    cache: options.cache,
  })

  return {
    ...baseSource,
    cache: options.cache,
    materialize: options.materialize || "lazy",
    mount: options.mount,
    validate: options.validate,
  }
}

export type {
  McpResourceContent,
  McpResourceDescriptor,
  McpResourcesClient,
  McpResourcesClientConfig,
  McpResourcesRequestOptions,
  McpResourcesServer,
} from "@vite-hub/source"
