import { resolve } from "node:path"

import { readBuildRevision } from "@vite-hub/internal/build/revision"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import type { Plugin } from "vite"

export interface HealthOptions {
  /** The route that answers the health check. Default: `/api/_vitehub/health`. */
  route?: string
}

export const defaultHealthRoute = "/api/_vitehub/health"

/**
 * The health handler: `{ ok, commit }`, and with a Database, `databases` with whether each one answered `SELECT 1`.
 * It answers 503 when a Database fails. The response holds no error text, so it shows no connection details.
 */
export function renderHealthHandler(input: { commit: string | null, database: boolean }): string {
  const headers = `{ "cache-control": "no-store" }`
  return [
    ...(input.database ? [`import { pingDatabases } from "@vite-hub/database/runtime/registry"`, ""] : []),
    `const commit = ${JSON.stringify(input.commit)}`,
    "",
    "export default {",
    "  async fetch() {",
    ...(input.database
      ? [
          "    const databases = await pingDatabases()",
          "    const ok = Object.values(databases).every(Boolean)",
          `    return Response.json({ ok, commit, databases }, { headers: ${headers}, status: ok ? 200 : 503 })`,
        ]
      : [`    return Response.json({ ok: true, commit }, { headers: ${headers} })`]),
    "  },",
    "}",
    "",
  ].join("\n")
}

/** Registers the health route, with the commit that the build comes from. */
export function healthVitePlugin(options: HealthOptions, target: { database: boolean }): Plugin {
  return {
    name: "vite-hub/health",
    async config(config) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, nitro?: Record<string, unknown> }
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root || process.cwd())
      const handler = resolve(projectRoot, ".vitehub/nitro/health.mjs")
      const { commit } = await readBuildRevision(projectRoot)
      await writeFileIfChanged(handler, renderHealthHandler({ commit: commit ?? null, database: target.database }))
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addHandler({ handler, route: options.route ?? defaultHealthRoute })
      viteConfig.nitro = kit.config
    },
  }
}
