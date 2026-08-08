import { createCloudflareHostedWorker } from "@vite-hub/internal/runtime/cloudflare-hosted"

import { normalizeWorkflowOptions } from "../config.ts"

import type { WorkflowApp } from "./_app.ts"
import { createCloudflareRuntimeEvent, runWithActiveCloudflareEnv, type CloudflareWorkerEnv, type CloudflareWorkerExecutionContext } from "./cloudflare-shared.ts"
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

export function installWorkflowCloudflareRuntime(options: WorkflowCloudflareWorkerOptions = {}): void {
  const workflowConfig = options.workflow === false ? false : normalizeWorkflowOptions(options.workflow, { hosting: "cloudflare" })!
  setWorkflowRuntimeConfig(workflowConfig)
  setWorkflowRuntimeRegistry(options.registry)
}

export function createWorkflowCloudflareWorker(options: WorkflowCloudflareWorkerOptions = {}): WorkflowCloudflareWorker {
  return createCloudflareHostedWorker({
    app: options.app,
    label: "workflow",
    async onRequest({ env, executionContext, handle }) {
      installWorkflowCloudflareRuntime(options)
      const runtimeEvent = createCloudflareRuntimeEvent(env, executionContext)
      return await runWithActiveCloudflareEnv(env, () => runWithWorkflowRuntimeEvent(runtimeEvent, () => handle(runtimeEvent.context)))
    },
  })
}
