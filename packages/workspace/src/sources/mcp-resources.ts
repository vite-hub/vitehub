import { mcpResources as createMcpResourcesSource, type McpResourcesSourceOptions as SourcePackageMcpResourcesSourceOptions } from "@vite-hub/source/mcp"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { prepareWorkspaceSource } from "./preparation.ts"
import { markLiveWorkspaceSource } from "./live.ts"
import { registerMcpResourcesSourceLoader } from "./mcp-resources-loader.ts"
import { withWorkspaceRuntimeOptions } from "./runtime-options.ts"

import type { ExactOptions, WorkspaceSourceRuntimeOptions } from "./runtime-options.ts"
import type { WorkspaceSource } from "../core/types.ts"

export interface McpResourcesSourceOptions<TKey extends string = string>
  extends Omit<SourcePackageMcpResourcesSourceOptions<TKey>, "cache">, WorkspaceSourceRuntimeOptions {}

export function mcpResources<const TKey extends string = string, const TOptions extends McpResourcesSourceOptions<TKey> = McpResourcesSourceOptions<TKey>>(options: ExactOptions<TOptions, McpResourcesSourceOptions<TKey>>): WorkspaceSource {
  const livePaths: Record<string, string> = {}
  const baseSource = createMcpResourcesSource({
    ...options,
    cache: options.cache,
  })

  const source = withWorkspaceRuntimeOptions({
    ...baseSource,
    async prepare(ctx) {
      await prepareWorkspaceSource(baseSource, ctx)
      const mountPath = resolveMountPath(options.mount, ctx)
      const keys = await baseSource.getKeys(ctx)
      resetLivePaths(livePaths, mountPath, keys)
    },
  }, {
    ...options,
    materialize: options.materialize || (options.sync ? "none" : "lazy"),
  })

  return markLiveWorkspaceSource(source, livePaths)
}

registerMcpResourcesSourceLoader(input => mcpResources(input as never))

function resolveMountPath(mount: WorkspaceSource["mount"], ctx: { mountPath?: string, source?: string }) {
  const explicit = typeof mount === "string" ? mount : mount?.path
  return normalizeSafeWorkspacePath(explicit ?? ctx.mountPath ?? ctx.source ?? "", { allowEmpty: true })
}

function resetLivePaths(paths: Record<string, string>, mountPath: string, keys: string[]) {
  for (const path of Object.keys(paths)) delete paths[path]
  for (const key of keys) {
    const path = normalizeSafeWorkspacePath(`${mountPath}/${key}`.replace(/\/+/g, "/"), { allowEmpty: false })
    paths[path] = key
  }
}

export type {
  McpResourceContent,
  McpResourceDescriptor,
  McpResourcesClient,
  McpResourcesClientConfig,
  McpResourcesRequestOptions,
  McpResourcesServer,
  McpResourcesTransport,
} from "@vite-hub/source/mcp"
