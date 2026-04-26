import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { H3, fromWebHandler } from "h3"
import { toNodeHandler } from "h3/node"

import type { IncomingMessage, ServerResponse } from "node:http"

import { resolveWorkflowAppFetch, type WorkflowApp } from "./_app.ts"
import { runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry } from "../types.ts"

interface WorkflowVercelServerOptions {
  app?: WorkflowApp
  registry?: WorkflowDefinitionRegistry
  workflow?: false | ResolvedWorkflowOptions
}

export type WorkflowVercelServer = (req: IncomingMessage, res: ServerResponse) => unknown

export function createWorkflowVercelServer(options: WorkflowVercelServerOptions = {}): WorkflowVercelServer {
  setWorkflowRuntimeConfig(options.workflow)
  setWorkflowRuntimeRegistry(options.registry)

  const app = new H3()
  const fetchHandler = resolveWorkflowAppFetch(options.app)
  if (fetchHandler) {
    app.use(fromWebHandler(async (request, context) => await fetchHandler(request, context)))
  }

  const nodeHandler = toNodeHandler(app)
  return function vercelWorkflowServer(req, res) {
    return runWithWorkflowRuntimeEvent({ req, res, waitUntil: vercelWaitUntil }, () => nodeHandler(req, res))
  }
}
