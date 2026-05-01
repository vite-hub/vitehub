import type { NitroOptions } from "nitro/types"
import type { ResolvedWorkspaceModuleOptions } from "../types.ts"

export function configureCloudflareArtifacts(
  target: Pick<NitroOptions, "cloudflare">,
  config: false | ResolvedWorkspaceModuleOptions,
): void {
  if (!config) return
  const store = config.store
  if (store.provider !== "cloudflare-artifacts") return

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  const wrangler = target.cloudflare.wrangler as typeof target.cloudflare.wrangler & {
    artifacts?: Array<{ binding: string, namespace: string }>
  }
  const artifacts = (wrangler.artifacts ||= [])
  if (!artifacts.some(existing => existing.binding === store.binding)) {
    artifacts.push({
      binding: store.binding || "WORKSPACE_ARTIFACTS",
      namespace: store.namespace || "vitehub",
    })
  }
}
