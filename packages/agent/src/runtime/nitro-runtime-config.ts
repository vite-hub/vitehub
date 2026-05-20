import { useRuntimeConfig } from "nitro/runtime-config"

import type { ResolvedAgentModuleOptions } from "../types.ts"

export function getAgentRuntimeConfig(event?: unknown): Record<string, unknown> & { agent?: false | ResolvedAgentModuleOptions } {
  const runtimeConfig = (useRuntimeConfig as unknown as (event?: unknown) => Record<string, unknown> & { agent?: false | ResolvedAgentModuleOptions })(event)
  return globalThis.__vitehubApplyRuntimeEnvToRuntimeConfig?.(runtimeConfig, event) ?? runtimeConfig
}

declare global {
  // Installed by @vitehub/env/nitro when that integration is present.
  // eslint-disable-next-line no-var
  var __vitehubApplyRuntimeEnvToRuntimeConfig: ((runtimeConfig: Record<string, unknown>, event?: unknown) => Record<string, unknown>) | undefined
}
