import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import workflowRegistry from "#vitehub/workflow/registry"

import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions } from "../types.ts"

const workflowNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp) => {
  const runtimeConfig = useRuntimeConfig() as {
    workflow?: false | ResolvedWorkflowOptions
  }

  const applyRuntimeState = () => {
    setWorkflowRuntimeConfig(runtimeConfig.workflow)
    setWorkflowRuntimeRegistry(workflowRegistry)
  }

  applyRuntimeState()

  nitroApp.hooks.hook("request", (event) => {
    applyRuntimeState()
    enterWorkflowRuntimeEvent(event)
  })
})

export default workflowNitroPlugin
