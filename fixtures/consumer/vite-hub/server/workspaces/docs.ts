import { defineWorkspace } from "vite-hub/workspace"

export default defineWorkspace({
  store: { driver: "memory" },
})
