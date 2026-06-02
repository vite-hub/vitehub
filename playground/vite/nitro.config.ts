import { getViteMode, VITEHUB_MODES } from "@vite-hub/internal/build/mode"
import { hubAgent } from "@vite-hub/agent/vite"
import { hubKv } from "@vite-hub/kv/vite"
import { hubQueue } from "@vite-hub/queue/vite"
import { hubSandbox } from "@vite-hub/sandbox/vite"
import { hubSchedule } from "@vite-hub/schedule/vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"
import { hubWorkflow } from "@vite-hub/workflow/vite"
import { defineNitroConfig } from "nitro/config"

const getNitroMode = () => process.env.VITEHUB_NITRO_MODE
const mode = getNitroMode() || getViteMode()
const chatEnabled = mode === VITEHUB_MODES.chat
const scheduleEnabled = getNitroMode() === VITEHUB_MODES.schedule || getViteMode() === VITEHUB_MODES.schedule
const workflowEnabled = getNitroMode() === VITEHUB_MODES.workflow || getViteMode() === VITEHUB_MODES.workflow

const agent = hubAgent()
const kv = hubKv()
const queue = hubQueue()
const sandbox = hubSandbox()
const schedule = hubSchedule()
const workspace = hubWorkspace()
const workflow = hubWorkflow()

const modules = chatEnabled
  ? [agent.nitro]
  : [
      queue.nitro,
      schedule.nitro,
      kv.nitro,
      sandbox.nitro,
      workspace.nitro,
      ...(workflowEnabled ? [workflow.nitro] : []),
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
