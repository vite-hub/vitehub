import { cloudflareEmailDevShimSource, cloudflareWorkersDevShimSource } from "./cloudflare-workers-dev-shim.injected.ts"

import type { Nitro } from "nitro/types"
import type { Plugin } from "vite"

const cloudflareDevShims: Record<string, { id: string, source: string }> = {
  "cloudflare:email": { id: "\0vitehub-dev:cloudflare-email", source: cloudflareEmailDevShimSource },
  "cloudflare:workers": { id: "\0vitehub-dev:cloudflare-workers", source: cloudflareWorkersDevShimSource },
}

/**
 * Code that ViteHub generates for the Cloudflare host imports `cloudflare:workers` and `cloudflare:email`. `vite dev`
 * runs the Nitro server on Node by default, where these modules do not exist, so it gets the Node stubs that `nuxt dev`
 * uses: `env` reads the request bindings and `process.env`. The `miniflare` dev runner has the real modules.
 */
export function cloudflareNodeDevPlugin(): Plugin {
  let nitro: Nitro | undefined
  return {
    name: "vite-hub/cloudflare-node-dev",
    apply: "serve",
    enforce: "pre",
    nitro: {
      setup(instance) {
        nitro = instance
      },
    },
    resolveId(id) {
      const runner = nitro?.options.devServer.runner || process.env.NITRO_DEV_RUNNER
      if (runner !== "miniflare" && Object.hasOwn(cloudflareDevShims, id)) return cloudflareDevShims[id]!.id
    },
    load(id) {
      for (const shim of Object.values(cloudflareDevShims)) {
        if (shim.id === id) return shim.source
      }
    },
  }
}
