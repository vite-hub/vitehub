import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"

import type { Plugin } from "vite"

/**
 * Resolves pkce-challenge to its browser build in a Cloudflare production build.
 *
 * The MCP SDK client, which Content, Workspace, the Console, and the Agent bundle, imports pkce-challenge. Its 5.x
 * releases export only `browser` and `node` builds, so the `workerd` conditions match nothing and the build fails.
 * The browser build uses only Web Crypto, which Workers have.
 */
export function cloudflarePkceChallengePlugin(): Plugin {
  return {
    name: "vite-hub/cloudflare-pkce-challenge",
    apply: "build",
    enforce: "pre",
    resolveId: {
      filter: { id: /^pkce-challenge$/ },
      handler(id, importer) {
        if (id !== "pkce-challenge" || !importer || !isAbsolute(importer)) return
        // `require` resolves the `node` build, which sits next to the browser build.
        return join(dirname(createRequire(importer).resolve(id)), "index.browser.js")
      },
    },
  }
}
