import type { Plugin } from "vite"

export { createCloudflareAgentState, ViteHubAgentStateAdapter } from "./state/providers/cloudflare.ts"
export { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
export type {
  CloudflareAgentStateOptions,
  ViteHubAgentStateDurableObjectNamespace,
  ViteHubAgentStateDurableObjectStub,
} from "./state/providers/cloudflare.ts"

export const defaultCloudflareAgentStateBinding = "CHAT_STATE" as const
export const defaultCloudflareAgentStateClassName = "ViteHubAgentStateDO" as const
export const defaultCloudflareAgentStateMigrationTag = "vitehub-agent-state-v1" as const

export interface CloudflareAgentStateDurableObjectBinding {
  class_name: string
  name: string
}

export interface CloudflareAgentStateMigration {
  deleted_classes?: string[]
  new_sqlite_classes?: string[]
  tag: string
  [key: string]: unknown
}

export interface CloudflareAgentStateTarget {
  cloudflare?: {
    wrangler?: {
      durable_objects?: {
        bindings?: CloudflareAgentStateDurableObjectBinding[]
      }
      migrations?: CloudflareAgentStateMigration[]
    }
  }
}

export interface CloudflareAgentStateRollupTarget {
  rollupConfig?: {
    external?: unknown
    plugins?: unknown
  }
}

export interface CloudflareAgentStateEntrypointOptions {
  binding?: string
  className?: string
  migrationTag?: string
}

interface InternalCloudflareAgentStateEntrypointOptions extends CloudflareAgentStateEntrypointOptions {
  stateImport?: string
}

function resolveCloudflareAgentStateEntrypointOptions(options: CloudflareAgentStateEntrypointOptions = {}) {
  return {
    binding: options.binding || defaultCloudflareAgentStateBinding,
    className: options.className || defaultCloudflareAgentStateClassName,
    migrationTag: options.migrationTag || defaultCloudflareAgentStateMigrationTag,
  }
}

function removeDeletedClassFromMigration(migration: CloudflareAgentStateMigration, className: string): CloudflareAgentStateMigration | undefined {
  if (!Array.isArray(migration.deleted_classes) || !migration.deleted_classes.includes(className)) {
    return migration
  }

  const deletedClasses = migration.deleted_classes.filter(deletedClass => deletedClass !== className)
  const { deleted_classes: _deletedClasses, ...next } = migration
  if (deletedClasses.length > 0) {
    return {
      ...next,
      deleted_classes: deletedClasses,
    }
  }

  return Object.keys(next).length > 1 ? next : undefined
}

export function configureCloudflareAgentState(target: CloudflareAgentStateTarget, options: CloudflareAgentStateEntrypointOptions = {}): void {
  const { binding, className, migrationTag } = resolveCloudflareAgentStateEntrypointOptions(options)

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.durable_objects ||= {}
  target.cloudflare.wrangler.durable_objects.bindings ||= []
  target.cloudflare.wrangler.migrations ||= []

  const bindings = target.cloudflare.wrangler.durable_objects.bindings
  if (!bindings.some(entry => entry.name === binding && entry.class_name === className)) {
    bindings.push({
      class_name: className,
      name: binding,
    })
  }

  target.cloudflare.wrangler.migrations = target.cloudflare.wrangler.migrations
    .map(migration => removeDeletedClassFromMigration(migration, className))
    .filter((migration): migration is CloudflareAgentStateMigration => Boolean(migration))

  const migrations = target.cloudflare.wrangler.migrations
  if (!migrations.some(entry => Array.isArray(entry.new_sqlite_classes) && entry.new_sqlite_classes.includes(className))) {
    migrations.push({
      tag: migrationTag,
      new_sqlite_classes: [className],
    })
  }
}

function createCloudflareAgentStateEntrypointPlugin(options: CloudflareAgentStateEntrypointOptions = {}): Plugin {
  const { className } = resolveCloudflareAgentStateEntrypointOptions(options)
  const stateImport = (options as InternalCloudflareAgentStateEntrypointOptions).stateImport ?? "@vite-hub/agent/cloudflare/state"
  const moduleId = "virtual:vitehub-agent-cloudflare-state-exports"
  const resolvedModuleId = "\0virtual:vitehub-agent-cloudflare-state-exports"

  return {
    name: "vitehub-agent-cloudflare-state-exports",
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: moduleId,
        fileName: "agent-cloudflare-state-exports.mjs",
      })
    },
    resolveId(id: string) {
      if (id === moduleId) return resolvedModuleId
    },
    load(id: string) {
      if (id === resolvedModuleId) {
        return [
          `export { ${className} } from ${JSON.stringify(stateImport)}`,
          "",
        ].join("\n")
      }
    },
    renderChunk(code: string, chunk: { fileName: string, isEntry: boolean }) {
      if (!chunk.isEntry || chunk.fileName !== "index.mjs") return null

      return {
        code: `${code}\nexport { ${className} } from './agent-cloudflare-state-exports.mjs'\n`,
        map: null,
      }
    },
  }
}

export function installCloudflareAgentStateEntrypoint(target: CloudflareAgentStateRollupTarget, options: CloudflareAgentStateEntrypointOptions = {}): void {
  const { className } = resolveCloudflareAgentStateEntrypointOptions(options)
  target.rollupConfig ||= {}
  const plugins = Array.isArray(target.rollupConfig.plugins) ? target.rollupConfig.plugins : []
  target.rollupConfig.plugins = plugins
  const pluginName = `vitehub-agent-cloudflare-state-exports:${className}`
  if (plugins.some(plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && (plugin as { name?: string }).name === pluginName)) {
    return
  }

  const plugin = createCloudflareAgentStateEntrypointPlugin({
    ...(options as InternalCloudflareAgentStateEntrypointOptions),
    className,
  })
  plugin.name = pluginName
  plugins.push(plugin)
}
