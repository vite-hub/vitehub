import chatRegistry, * as chatRegistryModule from "#vitehub/agent/chat/registry"
import { defineChatDevtoolsRegistryHandler } from "../nitro/devtools.ts"

import type { EventHandler } from "h3"

const handler: EventHandler = defineChatDevtoolsRegistryHandler(chatRegistry as never, {
  metadata: (chatRegistryModule as { metadata?: unknown }).metadata as never,
})

export default handler
