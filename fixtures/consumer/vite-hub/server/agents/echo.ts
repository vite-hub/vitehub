import { defineAgent } from "vite-hub/agent"
import { workspaceShell } from "vite-hub/agent/capabilities"
import { webChat } from "vite-hub/agent/channels"

import { renderMarkdownTemplate } from "vite-hub/markdown-template"

export default defineAgent({
  capabilities: [workspaceShell()],
  channels: { web: webChat() },
  description: "Deterministic consumer-contract Agent.",
  driver: {
    async run({ tools }) {
      const executeShell = tools?.shell?.execute
      if (!executeShell) throw new Error("Expected the Workspace Shell capability.")
      const pwd = await executeShell({ command: "pwd" }) as { stdout: string }
      return { text: `VITE_HUB_SERVER_ONLY:${await renderMarkdownTemplate("{{ cwd }}", { data: { cwd: pwd.stdout.trim() } })}` }
    },
  },
  workspace: { mode: "write", store: { provider: "memory" } },
})
