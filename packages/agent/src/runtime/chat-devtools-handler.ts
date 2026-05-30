import agentRegistry, { metadata } from "#vitehub/agent/registry"
import { defineAgentDevtoolsRegistryHandler } from "../chat/nitro/devtools.ts"

import type { EventHandler } from "h3"

const handler: EventHandler = defineAgentDevtoolsRegistryHandler(agentRegistry as never, { metadata })

export default handler
