import { docsAssistant } from "@vite-hub/docs/assistant"
import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  extends: docsAssistant,
  driver: { instructions: "Lumen is a command-line tool. Show commands with the `lumen` binary." },
})
