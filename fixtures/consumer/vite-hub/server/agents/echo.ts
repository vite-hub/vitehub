import { defineAgent } from "vite-hub/agent"
import { workspaceShell } from "vite-hub/agent/capabilities"
import { webChat } from "vite-hub/agent/channels"
import prompt from "./echo.md?markdown-template"

export default defineAgent({
  capabilities: [workspaceShell()],
  channels: { web: webChat() },
  description: "Deterministic consumer-contract Agent.",
  driver: {
    async run({ tools }) {
      const executeShell = tools?.shell?.execute
      if (!executeShell) throw new Error("Expected the Workspace Shell capability.")
      const pwd = await executeShell({ command: "pwd" }) as { stdout: string }
      return { text: `${await prompt({ cwd: pwd.stdout.trim() })}:VITE_HUB_SERVER_ONLY` }
    },
  },
  workspace: { mode: "write", store: { provider: "memory" } },
})
