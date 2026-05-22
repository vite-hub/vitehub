import { getNitroMode, getViteMode, VITEHUB_MODES } from "@vitehub/internal/build/mode"
import { defineNitroConfig } from "nitro/config"

const mode = getNitroMode() || getViteMode()
const chatEnabled = mode === VITEHUB_MODES.chat
const workflowEnabled = getNitroMode() === VITEHUB_MODES.workflow || getViteMode() === VITEHUB_MODES.workflow
const modules = chatEnabled
  ? ["@vitehub/agent/chat/nitro"]
  : [
      "@vitehub/queue/nitro",
      "@vitehub/kv/nitro",
      "@vitehub/sandbox/nitro",
      "@vitehub/workspace/nitro",
      ...(workflowEnabled ? ["@vitehub/workflow/nitro"] : []),
    ]

export default defineNitroConfig({
  modules,
  ignore: workflowEnabled || chatEnabled ? [] : ["api/workflows/**", "workflows/**"],
  chat: chatEnabled
    ? {
        cloudflare: { durableObjectState: false },
        dev: { initialize: false },
        provider: "nitro",
        webhook: false,
      }
    : false,
  queue: {},
  sandbox: {},
  serverDir: "./server",
  workspace: {},
  workflow: workflowEnabled ? {} : false,
})
