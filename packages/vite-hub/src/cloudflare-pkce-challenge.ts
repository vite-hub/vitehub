import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"

import type { Plugin } from "vite"

export function cloudflarePkceChallengePlugin(): Plugin {
  return {
    name: "vite-hub/cloudflare-pkce-challenge",
    apply: "build",
    enforce: "pre",
    resolveId: {
      filter: { id: /^pkce-challenge$/ },
      handler(id, importer) {
        if (id !== "pkce-challenge" || !importer || !isAbsolute(importer)) return
        return join(dirname(createRequire(importer).resolve(id)), "index.browser.js")
      },
    },
  }
}
