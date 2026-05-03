import { useRuntimeConfig } from "nitro/runtime-config"

import type { H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"

export function getChatRuntimeConfig(event: H3Event): NitroRuntimeConfig {
  return (useRuntimeConfig as unknown as (event?: H3Event) => NitroRuntimeConfig)(event)
}
