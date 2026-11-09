import { includedNitro } from "./nitro-plugin.ts"
import { viteHubPlugins } from "./plugins.ts"

import type { PluginOption } from "vite"
import type { ViteHubConfig, ViteHubOptions } from "./plugins.ts"

export { detectHost } from "./deployment.ts"
export type { ViteHubHost } from "./deployment.ts"

export type {
  AgentInvocationsDefault,
  AgentInvocationsDefaultJournal,
  CacheOptions,
  ConsoleOptions,
  LogsEvlogOptions,
  LogsOptions,
  ObservabilityEvlogOptions,
  ObservabilityOptions,
  ViteHubAgentOptions,
  ViteHubCloudflareOptions,
  ViteHubConfig,
  ViteHubConnectionsOptions,
  ViteHubOptions,
} from "./plugins.ts"

/** The ViteHub Vite plugins and Nitro, the server of the app. Nitro steps aside when the app adds `nitro()` itself. */
export function vitehub(options: ViteHubOptions = {}): PluginOption[] {
  return [...viteHubPlugins(options), includedNitro()]
}

declare module "vite" {
  interface UserConfig {
    vitehub?: ViteHubConfig
  }
}
