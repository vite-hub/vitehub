import { defineAgent } from '@vite-hub/agent'
import { webChat } from '@vite-hub/agent/channels'

export default defineAgent({
  channels: { web: webChat() },
  driver: { run: () => ({ text: 'deno fixture' }) },
})
