import { startPackageChecks } from "./internal/optional-owners.ts"
import { includedNitro } from "./nitro-plugin.ts"
import { viteHubPlugins } from "./plugins.ts"

import type { PluginOption } from "vite"
import type { ViteHubOptions } from "./plugins.ts"

export { detectHost } from "./deployment.ts"
export type { ViteHubHost } from "./deployment.ts"

export type {
  AgentInvocationsDefault,
  AgentInvocationsDefaultJournal,
  AgentOptions,
  AuthOptions,
  BlobOptions,
  BrowserOptions,
  CacheOptions,
  ChannelsOptions,
  CloudflareOptions,
  ConnectionsOptions,
  ConsoleOptions,
  DatabaseOptions,
  EmailOptions,
  EnvOptions,
  I18nOptions,
  KVOptions,
  ObservabilityEvlogOptions,
  ObservabilityLogsOptions,
  ObservabilityOptions,
  QueueOptions,
  RateLimitOptions,
  RealtimeOptions,
  SandboxTaskOptions,
  ScheduleOptions,
  SystemdOptions,
  ViteHubNodeOptions,
  ViteHubOptions,
  ViteHubQueueOptions,
  WorkflowOptions,
  WorkspaceOptions,
} from "./plugins.ts"

/** The ViteHub Vite plugins and Nitro, the server of the app. Nitro steps aside when the app adds `nitro()` itself. */
export function vitehub(options: ViteHubOptions = {}): PluginOption[] {
  startPackageChecks()
  return [...viteHubPlugins(options), includedNitro()]
}
