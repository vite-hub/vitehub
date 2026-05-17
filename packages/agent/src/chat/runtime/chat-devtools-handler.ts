import { defineChatDevtoolsSingletonHandler } from "../nitro/devtools.ts"

import type { EventHandler } from "h3"

const handler: EventHandler = defineChatDevtoolsSingletonHandler()

export default handler
