import { docsAssistant } from "@vite-hub/docs/assistant"
import { defineAgent } from "vite-hub/agent"

// The docs assistant. In this Worker it runs a model-backed Driver on the ChatGPT plan of the `chatgpt` Connection.
export default defineAgent({ extends: docsAssistant, workspace: {} })
