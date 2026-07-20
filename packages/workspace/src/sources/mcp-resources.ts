import { mcpResources as createMcpResourcesSource } from "@vite-hub/source/sources/mcp-resources"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { markLiveWorkspaceSource } from "./live.ts"
import { registerMcpResourcesSourceLoader } from "./mcp-resources-loader.ts"

import type { WorkspaceSource } from "../core/types.ts"
import type { McpResourcesSourceOptions as SourcePackageMcpResourcesSourceOptions } from "@vite-hub/source/sources/mcp-resources"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "sync" | "validate">
type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>

export interface McpResourcesSourceOptions<TKey extends string = string>
  extends Omit<SourcePackageMcpResourcesSourceOptions<TKey>, "cache">, SourceRuntimeOptions {}

export function mcpResources<const TKey extends string = string, const TOptions extends McpResourcesSourceOptions<TKey> = McpResourcesSourceOptions<TKey>>(options: ExactOptions<TOptions, McpResourcesSourceOptions<TKey>>): WorkspaceSource {
  const livePaths: Record<string, string> = {}
  const baseSource = createMcpResourcesSource({
    ...options,
    cache: options.cache,
  })

  return markLiveWorkspaceSource({
    ...baseSource,
    cache: options.cache,
    materialize: options.materialize || (options.sync ? "none" : "lazy"),
    mount: options.mount,
    async prepare(ctx) {
      await baseSource.prepare?.(ctx)
      const mountPath = resolveMountPath(options.mount, ctx)
      const keys = await baseSource.getKeys(ctx)
      resetLivePaths(livePaths, mountPath, keys)
    },
    sync: options.sync,
    validate: options.validate,
  }, livePaths)
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
} from "@vite-hub/source/sources/mcp-resources"
