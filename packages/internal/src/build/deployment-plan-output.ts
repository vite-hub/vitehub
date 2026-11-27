import { access, mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"

import type { DeploymentPlan, ViteHubHost } from "../deployment.ts"
import type { ViteHubProviderOutputEntry } from "../inspect.ts"
import { internalErrorDiagnostics } from "../error-diagnostics.ts"

/**
 * One set of host variables that the deployed app reads, as `deployment.json` lists it: a Server Env declaration, or
 * a variable that a primitive reads itself, such as `VITEHUB_SECRET` or `BLOB_READ_WRITE_TOKEN`.
 * It holds names only, so `vitehub deploy` can check the host without booting Vite. It never holds a value.
 */
export interface DeploymentEnvEntry {
  /** The declaration path, such as `env.server.github.token`, when it is safe to show. Primitive entries have none. */
  path?: string
  /** The host variable names, in read order. The first name that is set supplies the value. */
  names: readonly string[]
  /** Any variable whose name starts with this prefix supplies the value, such as `VITEHUB_CONSOLE_KEY_`. */
  prefix?: string
  required: boolean
  secret: boolean
  /** A default supplies the value when no name is set. */
  hasDefault: boolean
  /** The primitives that read these names, such as `blob`. Server Env declarations have none. */
  owners?: readonly string[]
}

/** What `vitehub deploy` does after it uploads the build, from `deploy` and `health` of `vitehub()`. */
export interface DeploymentDeployManifest {
  /** Paths on the deployed URL that must answer with a 2xx status, such as `/_vitehub/health`. */
  check: readonly string[]
  /** Submit the sitemap URLs of `url` to IndexNow after a production deploy. The site serves `/<key>.txt`. */
  indexNow?: { key: string, url: string }
}

/** What a primitive needs to know to name the variables it reads in the deployed app. */
export interface DeploymentEnvContext {
  host: ViteHubHost
}

/**
 * The host variables that a primitive reads itself, outside the Server Env registry, for one host and its resolved
 * config. A Vite plugin exposes it as `api.deploymentEnv`, and the build writes the result to `deployment.json`.
 * Return names only, never values.
 */
export type DeploymentEnvContribution = (context: DeploymentEnvContext) => readonly DeploymentEnvEntry[]

// A host variable name. Anything else is dropped, since a name with other characters may hold data.
const hostVariableName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function deploymentEnvContribution(plugin: unknown): DeploymentEnvContribution | undefined {
  if (!plugin || typeof plugin !== "object") return
  const api: unknown = Reflect.get(plugin, "api")
  if (!api || typeof api !== "object") return
  const contribution: unknown = Reflect.get(api, "deploymentEnv")
  // SAFETY: `api.deploymentEnv` is the documented contribution member. Its result passes through `deploymentEnvEntry()`.
  return typeof contribution === "function" ? contribution as DeploymentEnvContribution : undefined
}

/** The entries that the Vite plugins contribute through `api.deploymentEnv` for one host. */
export function collectDeploymentEnv(plugins: readonly unknown[] | undefined, context: DeploymentEnvContext): DeploymentEnvEntry[] {
  return (plugins ?? []).flatMap(plugin => deploymentEnvContribution(plugin)?.(context) ?? [])
}

/**
 * Joins entries that read the same names: the result is required when one of them is, secret when one of them is,
 * and has a default only when all of them have one. Entries keep their first order.
 */
export function mergeDeploymentEnv(entries: readonly DeploymentEnvEntry[]): DeploymentEnvEntry[] {
  const merged = new Map<string, DeploymentEnvEntry>()
  for (const entry of entries) {
    const key = JSON.stringify([entry.path ?? null, entry.names, entry.prefix ?? null])
    const current = merged.get(key)
    if (!current) {
      merged.set(key, entry)
      continue
    }
    const owners = [...new Set([...current.owners ?? [], ...entry.owners ?? []])]
    merged.set(key, {
      ...current,
      required: current.required || entry.required,
      secret: current.secret || entry.secret,
      hasDefault: current.hasDefault && entry.hasDefault,
      ...(owners.length ? { owners } : {}),
    })
  }
  return [...merged.values()]
}

interface FinalizeDeploymentPlanOutputOptions {
  /** The steps of `vitehub deploy` after the upload. Omit it when there are none. */
  deploy?: DeploymentDeployManifest
  /** The Server Env and primitive names to record. Omit it when the app has no Env plugin and no primitive names. */
  env?: readonly DeploymentEnvEntry[]
  /**
   * Vite's resolved `envDir`: an absolute folder, or `false` when Vite loads no env file. The manifest keeps it relative
   * to its own folder, so `vitehub env push` and `vitehub deploy` read the env files that the app reads.
   */
  envDir?: string | false
  identity?: {
    name: string
    source: string
  }
  outputDir?: string
  plan: DeploymentPlan
  rootDir: string
  services?: object
}

interface ResolvedPlanOutput {
  /** The Provider Output root that holds `deployment.json`. */
  root: string
  /** The Nitro server entry, relative to `root`. */
  entry?: string
  /** Where Nitro wrote its server functions, when that differs from `root`. */
  nitroFunctions?: string
}

function resolvePlanOutput(plan: DeploymentPlan, rootDir: string, outputDir?: string): ResolvedPlanOutput {
  const nitroOutputRoot = resolve(rootDir, outputDir ?? plan.output.directory)
  if (plan.host !== "netlify") return { entry: plan.output.entry, root: nitroOutputRoot }
  const root = basename(nitroOutputRoot) === "functions" && basename(dirname(nitroOutputRoot)) === "v1" ? dirname(dirname(nitroOutputRoot)) : nitroOutputRoot
  return { entry: plan.output.entry, nitroFunctions: resolve(root, "v1", "functions"), root }
}

/**
 * Lists the Provider Output that a Deployment Plan writes, for `vitehub inspect output`.
 * Paths use the resolved Nitro output directory when the host provides one.
 */
export function describeDeploymentPlanOutput(plan: DeploymentPlan, rootDir: string, outputDir?: string): ViteHubProviderOutputEntry[] {
  const output = resolvePlanOutput(plan, rootDir, outputDir)
  const entries: ViteHubProviderOutputEntry[] = [
    { description: "Deployment manifest with host, runtime, output, services, and Server Env names", owner: "vite-hub", path: resolve(output.root, "deployment.json") },
  ]
  if (plan.host === "cloudflare") {
    entries.push({ description: "Generated Cloudflare Worker config", owner: "vite-hub", path: resolve(output.root, "server/wrangler.json") })
  }
  if (plan.host === "vercel") {
    entries.push({ description: "Vercel Build Output config", owner: "vite-hub", path: resolve(output.root, "config.json") })
  }
  if (output.nitroFunctions) {
    entries.push({ description: "Nitro Netlify server functions", owner: "vite-hub", path: output.nitroFunctions })
  }
  if (plan.host === "netlify") {
    entries.push({ description: "Netlify function and static config output", owner: "vite-hub", path: resolve(output.root, "v1") })
  }
  return entries
}

// Copy the known fields only, so a caller cannot put a value into the manifest by accident.
function deploymentEnvEntry(entry: DeploymentEnvEntry): DeploymentEnvEntry {
  const owners = entry.owners?.filter(owner => /^[a-z][a-z0-9-]{0,63}$/.test(owner))
  return {
    ...(entry.path === undefined ? {} : { path: entry.path }),
    names: entry.names.filter(name => hostVariableName.test(name)),
    ...(entry.prefix !== undefined && hostVariableName.test(entry.prefix) ? { prefix: entry.prefix } : {}),
    required: entry.required,
    secret: entry.secret,
    hasDefault: entry.hasDefault,
    ...(owners?.length ? { owners } : {}),
  }
}

export async function finalizeDeploymentPlanOutput(options: FinalizeDeploymentPlanOutputOptions): Promise<void> {
  const output = resolvePlanOutput(options.plan, options.rootDir, options.outputDir)
  const entry = output.entry ? resolve(output.root, output.entry) : undefined
  if (entry) {
    try {
      await access(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      throw internalErrorDiagnostics.INTERNAL_B0040({ message: "[vitehub] The " + JSON.stringify(options.plan.host) + " host did not emit its required entry: " + entry + "." })
    }
  }
  const manifest = {
    host: options.plan.host,
    ...(options.identity ? { identity: options.identity } : {}),
    output: {
      ...options.plan.output,
      directory: relative(options.rootDir, output.root).replaceAll("\\", "/") || ".",
      ...(output.entry ? { entry: output.entry } : {}),
    },
    runtime: options.plan.runtime,
    services: options.services ?? options.plan.services,
    ...(options.env ? { env: options.env.map(deploymentEnvEntry).filter(entry => entry.names.length || entry.prefix) } : {}),
    ...(options.envDir === undefined ? {} : { envDir: options.envDir === false ? false : relative(output.root, options.envDir).replaceAll("\\", "/") || "." }),
    ...(options.deploy ? { deploy: options.deploy } : {}),
  }
  const manifestPath = resolve(output.root, "deployment.json")
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
}
