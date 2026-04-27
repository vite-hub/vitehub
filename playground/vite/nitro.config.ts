import { getNitroMode, getViteMode, VITEHUB_MODES } from "@vitehub/internal/build/mode"
import { defineNitroConfig } from "nitro/config"

const workflowEnabled = getNitroMode() === VITEHUB_MODES.workflow || getViteMode() === VITEHUB_MODES.workflow

export default defineNitroConfig({
  modules: [
    "@vitehub/queue/nitro",
    "@vitehub/kv/nitro",
    "@vitehub/sandbox/nitro",
    ...(workflowEnabled ? ["@vitehub/workflow/nitro"] : []),
  ],
  ignore: workflowEnabled ? [] : ["api/workflows/**", "workflows/**"],
  queue: {},
  sandbox: {},
  serverDir: "./server",
  workflow: workflowEnabled ? {} : false,
})
