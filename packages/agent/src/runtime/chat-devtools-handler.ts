import chatRegistry, { metadata as chatMetadata } from "#vitehub/agent/chat/registry"
import { defineChatDevtoolsRegistryHandler } from "../chat/nitro/devtools.ts"

import type { EventHandler } from "h3"

const handler: EventHandler = defineChatDevtoolsRegistryHandler(chatRegistry as never, {
  metadata: chatMetadata as never,
})

export default handler
