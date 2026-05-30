import { getViteMode, VITEHUB_MODES } from "@vite-hub/internal/build/mode"
import { defineNitroConfig } from "nitro/config"

const getNitroMode = () => process.env.VITEHUB_NITRO_MODE
const mode = getNitroMode() || getViteMode()
const chatEnabled = mode === VITEHUB_MODES.chat
const scheduleEnabled = getNitroMode() === VITEHUB_MODES.schedule || getViteMode() === VITEHUB_MODES.schedule
const workflowEnabled = getNitroMode() === VITEHUB_MODES.workflow || getViteMode() === VITEHUB_MODES.workflow
const modules = chatEnabled
  ? ["@vite-hub/agent/nitro"]
  : [
      "@vite-hub/queue/nitro",
      "@vite-hub/schedule/nitro",
      "@vite-hub/kv/nitro",
      "@vite-hub/sandbox/nitro",
      "@vite-hub/workspace/nitro",
      ...(workflowEnabled ? ["@vite-hub/workflow/nitro"] : []),
    ]

export default defineNitroConfig({
  modules,
  ignore: workflowEnabled || chatEnabled ? [] : ["api/workflows/**", "workflows/**"],
  agent: chatEnabled ? {} : false,
  queue: {},
  schedule: scheduleEnabled ? {} : false,
  sandbox: {},
  serverDir: "./server",
  workspace: {},
  workflow: workflowEnabled ? {} : false,
})
