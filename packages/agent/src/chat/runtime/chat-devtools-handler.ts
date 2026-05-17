import agentRegistry from "#vitehub/agent/registry"
import { defineChatDevtoolsRegistryHandler } from "../nitro/devtools.ts"

import type { EventHandler } from "h3"

const handler: EventHandler = defineChatDevtoolsRegistryHandler(agentRegistry as never)

export default handler
