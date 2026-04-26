import { resolveAppFetch, type VitehubApp } from "@vitehub/internal/runtime/app"

export type WorkflowApp = VitehubApp

export function resolveWorkflowAppFetch(app: WorkflowApp | undefined): ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>) | undefined {
  return resolveAppFetch("workflow", app)
}
