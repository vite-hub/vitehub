import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { createVercelHostedServer } from "@vite-hub/internal/runtime/vercel-hosted"

import type { IncomingMessage, ServerResponse } from "node:http"

import type { WorkflowApp } from "./_app.ts"
import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry } from "../types.ts"

export { setVercelWorkflowRuntimeModules } from "./vercel.ts"

export async function runWithVercelWorkflowRuntimeEvent<T>(req: unknown, res: unknown, run: () => T | Promise<T>): Promise<T> {
  return await runWithWorkflowRuntimeEvent({ req, res, waitUntil: vercelWaitUntil }, run)
}

interface WorkflowVercelServerOptions {
  app?: WorkflowApp
  registry?: WorkflowDefinitionRegistry
  workflow?: false | ResolvedWorkflowOptions
}

export type WorkflowVercelServer = (req: IncomingMessage, res: ServerResponse) => unknown

export function createWorkflowVercelServer(options: WorkflowVercelServerOptions = {}): WorkflowVercelServer {
  return createVercelHostedServer({
    app: options.app,
    label: "workflow",
    onRequest({ handle, req, res }) {
      setWorkflowRuntimeConfig(options.workflow)
      setWorkflowRuntimeRegistry(options.registry)
      return runWithVercelWorkflowRuntimeEvent(req, res, handle)
    },
  }) as WorkflowVercelServer
}
