import { resolve } from "node:path"

import { readBuildRevision } from "@vite-hub/internal/build/revision"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { readViteHubVersion } from "./version.ts"

import type { Plugin } from "vite"

export interface HealthOptions {
  /** The route that answers the health check. Default: `/api/_vitehub/health`. */
  route?: string
}

export const defaultHealthRoute = "/api/_vitehub/health"

/** How long one Database, KV store, or Blob store may take to answer the health check. */
export const healthCheckTimeoutMs = 2_000

/** The primitives of the app that the health route checks: the Databases, and the KV and Blob stores by name. */
export interface HealthTargets {
  database: boolean
  kv: readonly string[]
  blob: readonly string[]
}

/** A key that no app writes. KV and Blob read it to prove that the store answers, which costs one read. */
const probeKey = "vitehub-health-check"

/**
 * The health handler: `{ ok, commit, vitehub }`, and `checks` with whether each Database answered `SELECT 1` and
 * whether each KV and Blob store answered one read, within {@link healthCheckTimeoutMs}. It answers 503 when a check
 * fails. The response holds no error text, so it shows no connection details. The error goes to the server log.
 */
export function renderHealthHandler(input: { commit: string | null, vitehub: string } & HealthTargets): string {
  const headers = `{ "cache-control": "no-store" }`
  const groups = [
    ...(input.database ? [`database: import("@vite-hub/database/runtime/registry").then(({ pingDatabases }) => pingDatabases())`] : []),
    ...(input.kv.length ? [`kv: import("vite-hub/kv").then(({ kv }) => checkStores("KV store", ${JSON.stringify(input.kv)}, name => kv.store(name, { mode: "read" }).has(${JSON.stringify(probeKey)})))`] : []),
    ...(input.blob.length ? [`blob: import("vite-hub/blob").then(({ blob }) => checkStores("Blob store", ${JSON.stringify(input.blob)}, name => blob.store(name, { mode: "read" }).head(${JSON.stringify(probeKey)})))`] : []),
  ]
  return [
    `const commit = ${JSON.stringify(input.commit)}`,
    `const vitehub = ${JSON.stringify(input.vitehub)}`,
    "",
    ...(input.kv.length || input.blob.length
      ? [
          "/** Whether each store answers one read within the timeout. A store that fails is `false`, and its error goes to the server log. */",
          "async function checkStores(kind, names, read) {",
          "  return Object.fromEntries(await Promise.all(names.map(async (name) => {",
          "    let timer",
          "    try {",
          `      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No answer within ${healthCheckTimeoutMs} ms.")), ${healthCheckTimeoutMs}) })`,
          "      const [error] = await Promise.race([read(name), timeout])",
          "      if (error) throw error",
          "      return [name, true]",
          "    }",
          "    catch (error) {",
          "      console.error(`[vitehub] ${kind} ${JSON.stringify(name)} did not answer the health check.`, error)",
          "      return [name, false]",
          "    }",
          "    finally {",
          "      clearTimeout(timer)",
          "    }",
          "  })))",
          "}",
          "",
        ]
      : []),
    "export default {",
    "  async fetch() {",
    ...(groups.length
      ? [
          `    const pending = { ${groups.join(", ")} }`,
          "    const results = await Promise.all(Object.values(pending))",
          "    const checks = Object.fromEntries(Object.keys(pending).map((key, index) => [key, results[index]]))",
          "    const ok = results.every(group => Object.values(group).every(Boolean))",
          `    return Response.json({ ok, commit, vitehub, checks }, { headers: ${headers}, status: ok ? 200 : 503 })`,
        ]
      : [`    return Response.json({ ok: true, commit, vitehub }, { headers: ${headers} })`]),
    "  },",
    "}",
    "",
  ].join("\n")
}

/** Registers the health route, with the commit that the build comes from and the primitives to check. */
export function healthVitePlugin(options: HealthOptions, targets: HealthTargets): Plugin {
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
      await writeFileIfChanged(handler, renderHealthHandler({ commit: commit ?? null, vitehub: readViteHubVersion(), ...targets }))
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addHandler({ handler, route: options.route ?? defaultHealthRoute })
      viteConfig.nitro = kit.config
    },
  }
}
