import { useRuntimeConfig } from "nitro/runtime-config"

import type { ResolvedAgentModuleOptions } from "../types.ts"

export function getAgentRuntimeConfig(event?: unknown): Record<string, unknown> & { agent?: false | ResolvedAgentModuleOptions } {
  void event
  return useRuntimeConfig() as Record<string, unknown> & { agent?: false | ResolvedAgentModuleOptions }
}
