import { useRuntimeConfig } from "nitro/runtime-config"

import type { H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"

export function getChatRuntimeConfig(event: H3Event): NitroRuntimeConfig {
  const runtimeConfig = (useRuntimeConfig as unknown as (event?: H3Event) => NitroRuntimeConfig)(event)
  return (globalThis.__vitehubApplyRuntimeEnvToRuntimeConfig?.(runtimeConfig as Record<string, unknown>, event) ?? runtimeConfig) as NitroRuntimeConfig
}

declare global {
  // Installed by @vitehub/env/nitro when that integration is present.
  // eslint-disable-next-line no-var
  var __vitehubApplyRuntimeEnvToRuntimeConfig: ((runtimeConfig: Record<string, unknown>, event?: unknown) => Record<string, unknown>) | undefined
}
