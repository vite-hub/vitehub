import { defineChatDevtoolsHandler } from "@vitehub/agent/chat/nitro"

import chat from "../../../../chat"

export default defineChatDevtoolsHandler(chat, { inferredName: "chat" })
