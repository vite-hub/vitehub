import { defineNuxtModule } from "@nuxt/kit"
import type { NuxtModule } from "@nuxt/schema"
import type { NitroConfig } from "nitro/types"

import type { WorkflowModuleOptions } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/workflow/nitro"
type WorkflowNuxtModuleOptions = Exclude<WorkflowModuleOptions, false>

function installWorkflowNitroModule(nitro: NitroConfig, workflow: WorkflowModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) {
    nitro.modules.push(NITRO_MODULE_ID)
  }
  if (workflow !== undefined) {
    nitro.workflow = workflow
  }
}

const workflowNuxtModule: NuxtModule<WorkflowNuxtModuleOptions, WorkflowNuxtModuleOptions, false> = defineNuxtModule<WorkflowNuxtModuleOptions>({
  meta: { configKey: "workflow", name: "@vitehub/workflow/nuxt" },
  setup(inlineOptions, nuxt) {
    const topLevel = nuxt.options.workflow
    if (topLevel === false) {
      return
    }

    const workflow = topLevel ?? inlineOptions
    nuxt.options.nitro ||= {}
    installWorkflowNitroModule(nuxt.options.nitro, workflow)
    nuxt.hook("nitro:config", config => installWorkflowNitroModule(config, workflow))
  },
})

export default workflowNuxtModule

declare module "@nuxt/schema" {
  interface NuxtConfig {
    workflow?: WorkflowModuleOptions
    nitro?: NitroConfig
  }
  interface NuxtOptions {
    workflow?: WorkflowModuleOptions
    nitro?: NitroConfig
  }
  interface NuxtHooks {
    "nitro:config": (config: NitroConfig) => void | Promise<void>
  }
}
