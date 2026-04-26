import { defineNitroConfig } from "nitro/config"

const workflowEnabled = process.env.VITEHUB_NITRO_MODE === "workflow" || process.env.VITEHUB_VITE_MODE === "workflow"

export default defineNitroConfig({
  modules: [
    "@vitehub/queue/nitro",
    "@vitehub/kv/nitro",
    "@vitehub/sandbox/nitro",
    ...(workflowEnabled ? ["@vitehub/workflow/nitro"] : []),
  ],
  ignore: workflowEnabled
    ? []
    : [
        "api/workflows/**",
        "workflows/**",
      ],
  queue: {},
  sandbox: {},
  serverDir: "./server",
  workflow: workflowEnabled ? {} : false,
})
