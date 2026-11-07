import { defineWorkspace } from "vite-hub/workspace"

export default defineWorkspace({
  store: { provider: "cloudflare-artifacts", repository: "docs" },
})
