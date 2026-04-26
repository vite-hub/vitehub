import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import workflowRegistry from "#vitehub/workflow/registry"

import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions } from "../types.ts"

const workflowNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp) => {
  const runtimeConfig = useRuntimeConfig() as { workflow?: false | ResolvedWorkflowOptions }
  setWorkflowRuntimeConfig(runtimeConfig.workflow)
  setWorkflowRuntimeRegistry(workflowRegistry)

  nitroApp.hooks.hook("request", (event) => {
    enterWorkflowRuntimeEvent(event)
  })
})

export default workflowNitroPlugin
