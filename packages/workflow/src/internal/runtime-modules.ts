import { ownModule } from "@vite-hub/internal/build/paths"

export type WorkflowRuntimeModuleName = "cloudflare-runner" | "cloudflare-vite" | "dev-runs" | "execute" | "state" | "vercel-vite"

/**
 * The file path of a Workflow runtime module. Generated code imports it by path, so it needs no package export.
 * Schedule and Agent output receive these paths from the Workflow plugin.
 */
export function workflowRuntimeModule(name: WorkflowRuntimeModuleName): string {
  return ownModule(import.meta.url, `runtime/${name}`)
}
