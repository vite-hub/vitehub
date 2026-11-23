import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { readBuildRevision } from "@vite-hub/internal/build/revision"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { ownerModules } from "./internal/owner-modules.ts"
import { requireOptionalOwner } from "./internal/optional-owners.ts"
import { readViteHubVersion } from "./version.ts"

import type { Plugin } from "vite"

/** A primitive that the health route can check. */
export type HealthCheck = "database" | "kv" | "blob"

export interface HealthOptions {
  /** The route that answers the health check. Default: `/_vitehub/health`. */
  route?: string
  /**
   * The primitives that the route checks. Default: each of `database`, `kv`, and `blob` that the app turns on. `[]`
   * checks nothing and answers with the version and commit only.
   */
  checks?: readonly HealthCheck[]
}

export const defaultHealthRoute = "/_vitehub/health"

/** How long one Database, KV store, or Blob store may take to answer the health check. */
export const healthCheckTimeoutMs = 2_000

/** The primitives of the app that the health route checks: the Databases, and the KV and Blob stores by name. */
export interface HealthTargets {
  database: boolean
  kv: readonly string[]
  blob: readonly string[]
}

/** The targets that `checks` keeps. A listed primitive that the app does not turn on fails the build. */
export function selectHealthTargets(checks: readonly unknown[] | undefined, targets: HealthTargets): HealthTargets {
  if (!checks) return targets
  for (const check of checks) {
    if (check !== "database" && check !== "kv" && check !== "blob") throw viteHubErrorDiagnostics.VITE_HUB_HEALTH_CHECK_INVALID({ check: String(check) })
    if (check === "database" ? !targets.database : !targets[check].length) throw viteHubErrorDiagnostics.VITE_HUB_HEALTH_CHECK_DISABLED({ check })
  }
  return {
    database: checks.includes("database") && targets.database,
    kv: checks.includes("kv") ? targets.kv : [],
    blob: checks.includes("blob") ? targets.blob : [],
  }
}

/** A key that no app writes. KV reads it to prove that the store answers, which costs one read. */
const probeKey = "vitehub-health-check"

function blobHealthModule() {
  return requireOptionalOwner(ownerModules.blobVite, "blob").blobHealthModule
}

/**
 * The health handler: `{ ok, version, commit, vitehub }`, and `checks` with whether each Database answered `SELECT 1`,
 * each KV store answered one read, and each Blob store passed its driver check, within {@link healthCheckTimeoutMs}. It answers
 * 503 when a check fails. The response holds no error text, so it shows no connection details. The error goes to the
 * server log.
 */
export function renderHealthHandler(input: { version?: string, commit: string | null, vitehub: string } & HealthTargets): string {
  const headers = `{ "cache-control": "no-store" }`
  const groups = [
    ...(input.database ? [`database: import("@vite-hub/database/runtime/registry").then(({ pingDatabases }) => pingDatabases())`] : []),
    ...(input.kv.length ? [`kv: import("vite-hub/kv").then(({ kv }) => checkStores("KV store", ${JSON.stringify(input.kv)}, async (name) => { const [error] = await kv.store(name, { mode: "read" }).has(${JSON.stringify(probeKey)}); if (error) throw error }))`] : []),
    ...(input.blob.length ? [`blob: import(${JSON.stringify(blobHealthModule())}).then(({ checkBlobStoreHealth }) => checkStores("Blob store", ${JSON.stringify(input.blob)}, checkBlobStoreHealth))`] : []),
  ]
  const build = input.version ? "version, commit, vitehub" : "commit, vitehub"
  return [
    ...(input.version ? [`const version = ${JSON.stringify(input.version)}`] : []),
    `const commit = ${JSON.stringify(input.commit)}`,
    `const vitehub = ${JSON.stringify(input.vitehub)}`,
    "",
    ...(input.kv.length || input.blob.length
      ? [
          "/** Whether each store answers within the timeout. A store that fails is `false`, and its error goes to the server log. */",
          "async function checkStores(kind, names, check) {",
          "  return Object.fromEntries(await Promise.all(names.map(async (name) => {",
          "    let timer",
          "    try {",
          `      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No answer within ${healthCheckTimeoutMs} ms.")), ${healthCheckTimeoutMs}) })`,
          "      await Promise.race([check(name), timeout])",
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
          `    return Response.json({ ok, ${build}, checks }, { headers: ${headers}, status: ok ? 200 : 503 })`,
        ]
      : [`    return Response.json({ ok: true, ${build} }, { headers: ${headers} })`]),
    "  },",
    "}",
    "",
  ].join("\n")
}

/** The `version` of the app's `package.json`, when it has one. */
async function readAppVersion(projectRoot: string): Promise<string | undefined> {
  const manifest: unknown = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8").catch(() => "{}"))
  const version = manifest instanceof Object ? Reflect.get(manifest, "version") : undefined
  return typeof version === "string" && version ? version : undefined
}

/** Registers the health route, with the app version and commit of the build, and the primitives to check. */
export function healthVitePlugin(options: HealthOptions, available: HealthTargets): Plugin {
  return {
    name: "vite-hub/health",
    async config(config) {
      const targets = selectHealthTargets(options.checks, available)
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, nitro?: Record<string, unknown> }
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root || process.cwd())
      const handler = resolve(projectRoot, ".vitehub/nitro/health.mjs")
      const [{ commit }, version] = await Promise.all([readBuildRevision(projectRoot), readAppVersion(projectRoot)])
      await writeFileIfChanged(handler, renderHealthHandler({ ...(version ? { version } : {}), commit: commit ?? null, vitehub: readViteHubVersion(), ...targets }))
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addHandler({ handler, route: options.route ?? defaultHealthRoute })
      viteConfig.nitro = kit.config
    },
  }
}
