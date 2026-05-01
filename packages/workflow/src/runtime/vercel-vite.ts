import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { createVercelHostedServer } from "@vitehub/internal/runtime/hosted"

import type { IncomingMessage, ServerResponse } from "node:http"

import type { WorkflowApp } from "./_app.ts"
import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry } from "../types.ts"

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
      return runWithWorkflowRuntimeEvent({ req, res, waitUntil: vercelWaitUntil }, handle)
    },
  }) as WorkflowVercelServer
}
