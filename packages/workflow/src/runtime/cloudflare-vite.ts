import { H3, toWebHandler } from "h3"

import { normalizeWorkflowOptions } from "../config.ts"

import { resolveWorkflowAppFetch, type WorkflowApp } from "./_app.ts"
import { createCloudflareRuntimeEvent, setActiveCloudflareEnv, type CloudflareWorkerEnv, type CloudflareWorkerExecutionContext } from "./cloudflare-shared.ts"
import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry } from "../types.ts"

export type CloudflareWorkerApp = WorkflowApp

export interface WorkflowCloudflareWorkerOptions {
  app?: CloudflareWorkerApp
  registry?: WorkflowDefinitionRegistry
  workflow?: false | ResolvedWorkflowOptions
}

export interface WorkflowCloudflareWorker {
  fetch: (request: Request, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<Response>
}

export function createWorkflowCloudflareWorker(options: WorkflowCloudflareWorkerOptions = {}): WorkflowCloudflareWorker {
  const workflowConfig = options.workflow === false ? false : normalizeWorkflowOptions(options.workflow, { hosting: "cloudflare" })!
  const registry = options.registry
  const defaultHandler = toWebHandler(new H3())
  const appHandler = resolveWorkflowAppFetch(options.app)

  const applyRuntimeState = () => {
    setWorkflowRuntimeConfig(workflowConfig)
    setWorkflowRuntimeRegistry(registry)
  }

  return {
    async fetch(request, env, context) {
      applyRuntimeState()
      setActiveCloudflareEnv(env)
      const runtimeEvent = createCloudflareRuntimeEvent(env, context)
      return await runWithWorkflowRuntimeEvent(runtimeEvent, () => Promise.resolve(appHandler ? appHandler(request, runtimeEvent.context) : defaultHandler(request, runtimeEvent.context)))
    },
  }
}
