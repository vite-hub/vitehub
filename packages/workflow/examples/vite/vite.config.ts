import { defineConfig } from "vite"

import { hubWorkflow } from "@vitehub/workflow/vite"

export default defineConfig({
  plugins: [hubWorkflow()],
  workflow: {
    provider: "vercel",
  },
})
