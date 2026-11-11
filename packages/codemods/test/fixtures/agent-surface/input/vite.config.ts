import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({
    preset: "node",
    agent: {
      providers: { state: { provider: "sqlite", url: "file:.vitehub/agent-state.db" } },
    },
  })],
})
