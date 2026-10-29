import { defineConfig, loadEnv } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "VITEHUB_CONNECTIONS_KEY")
  if (env.VITEHUB_CONNECTIONS_KEY) process.env.VITEHUB_CONNECTIONS_KEY ??= env.VITEHUB_CONNECTIONS_KEY
  return {
    plugins: [vitehub({ preset: "node", agent: true, connections: true, workflow: false })],
    server: { host: "127.0.0.1", port: 1456, strictPort: true },
  }
})
