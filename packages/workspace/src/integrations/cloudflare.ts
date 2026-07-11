import { pushUnique } from "@vite-hub/internal/arrays"

import type { ResolvedWorkspaceModuleOptions } from "../core/types.ts"

interface CloudflareArtifactsTarget {
  cloudflare?: {
    wrangler?: {
      artifacts?: Array<{ binding: string, namespace: string }>
    }
  }
}

export function configureCloudflareArtifacts(
  target: CloudflareArtifactsTarget,
  config: false | ResolvedWorkspaceModuleOptions,
): void {
  if (!config) return
  const store = config.store
  if (store.provider !== "cloudflare-artifacts") return

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.artifacts ||= []
  const artifact = {
    binding: store.binding || "WORKSPACE_ARTIFACTS",
    namespace: store.namespace || "vitehub",
  }
  const existing = target.cloudflare.wrangler.artifacts.find(entry => entry.binding === artifact.binding)
  if (existing && existing.namespace !== artifact.namespace) {
    throw new TypeError(`[vitehub] Cloudflare Artifacts binding "${artifact.binding}" cannot use both namespace "${existing.namespace}" and "${artifact.namespace}". Configure a unique binding for each namespace.`)
  }

  pushUnique(
    target.cloudflare.wrangler.artifacts,
    artifact,
    entry => entry.binding,
  )
}
