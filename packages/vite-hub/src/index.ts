import { withShortInspect } from "./hook-errors.ts"
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
  DeployOptions,
  EmailOptions,
  EnvOptions,
  HealthOptions,
  I18nOptions,
  KVOptions,
  ObservabilityEvlogOptions,
  ObservabilityLogsOptions,
  ObservabilityOptions,
  QueueOptions,
  RateLimitOptions,
  RealtimeOptions,
  RedirectsOptions,
  SameOriginWritesOptions,
  SandboxTaskOptions,
  ScheduleOptions,
  SecurityHeaders,
  SecurityOptions,
  SeoOptions,
  SystemdOptions,
  ViteHubDeviceOptions,
  ViteHubNodeOptions,
  ViteHubOptions,
  ViteHubQueueOptions,
  WorkflowOptions,
  WorkspaceOptions,
} from "./plugins.ts"

/** The ViteHub Vite plugins and Nitro, the server of the app. Nitro steps aside when the app adds `nitro()` itself. */
export function vitehub(options: ViteHubOptions = {}): PluginOption[] {
  try {
    startPackageChecks()
    return [...viteHubPlugins(options, false), includedNitro()]
  }
  catch (error) {
    // Vite prints an error of the config file with `util.inspect`.
    throw withShortInspect(error)
  }
}
