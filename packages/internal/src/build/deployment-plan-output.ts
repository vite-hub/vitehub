import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"

import type { DeploymentPlan } from "../deployment.ts"
import type { ViteHubProviderOutputEntry } from "../inspect.ts"
import { internalErrorDiagnostics } from "../error-diagnostics.ts"

interface FinalizeDeploymentPlanOutputOptions {
  identity?: {
    name: string
    source: string
  }
  outputDir?: string
  plan: DeploymentPlan
  rootDir: string
  services?: object
}

const netlifyWrapperSource = 'export { default } from "../functions-internal/server/server.mjs"\n'

interface ResolvedPlanOutput {
  /** The Provider Output root that holds `deployment.json`. */
  root: string
  /** The Nitro server entry, relative to `root`. */
  entry?: string
  /** Where Nitro wrote its server functions, when that differs from `root`. */
  nitroFunctions?: string
  /** Whether Netlify needs `functions/server.mjs` to find the Nitro function. */
  netlifyWrapper: boolean
}

/**
 * Nitro's Netlify preset writes `.netlify/functions-internal` up to 3.0.260903-beta and
 * `.netlify/v1/functions` (Netlify's Frameworks API) from 3.0.261029-rc. Netlify discovers
 * the second layout itself, so only the first one gets a `functions/server.mjs` wrapper.
 */
function resolvePlanOutput(plan: DeploymentPlan, rootDir: string, outputDir?: string): ResolvedPlanOutput {
  const nitroOutputRoot = resolve(rootDir, outputDir ?? plan.output.directory)
  if (plan.preset !== "netlify") return { entry: plan.output.entry, netlifyWrapper: false, root: nitroOutputRoot }
  if (basename(nitroOutputRoot) === "functions" && basename(dirname(nitroOutputRoot)) === "v1") {
    return { entry: "v1/functions/server/server.mjs", netlifyWrapper: false, nitroFunctions: nitroOutputRoot, root: dirname(dirname(nitroOutputRoot)) }
  }
  const root = basename(nitroOutputRoot) === "functions-internal" ? dirname(nitroOutputRoot) : nitroOutputRoot
  return { entry: plan.output.entry, netlifyWrapper: true, nitroFunctions: resolve(root, "functions-internal"), root }
}

/**
 * Lists the Provider Output that a Deployment Plan writes, for `vitehub inspect provider-output`.
 * Paths use the resolved Nitro output directory when the host provides one.
 */
export function describeDeploymentPlanOutput(plan: DeploymentPlan, rootDir: string, outputDir?: string): ViteHubProviderOutputEntry[] {
  const output = resolvePlanOutput(plan, rootDir, outputDir)
  const entries: ViteHubProviderOutputEntry[] = [
    { description: "Deployment manifest with host, runtime, output, and services", owner: "vite-hub", path: resolve(output.root, "deployment.json") },
  ]
  if (plan.preset === "cloudflare") {
    entries.push({ description: "Generated Cloudflare Worker config", owner: "vite-hub", path: resolve(output.root, "server/wrangler.json") })
  }
  if (plan.preset === "vercel") {
    entries.push({ description: "Vercel Build Output config", owner: "vite-hub", path: resolve(output.root, "config.json") })
  }
  if (output.nitroFunctions) {
    entries.push({ description: "Nitro Netlify server functions", owner: "vite-hub", path: output.nitroFunctions })
  }
  if (output.netlifyWrapper) {
    entries.push({ description: "Netlify function entrypoint", owner: "vite-hub", path: resolve(output.root, "functions/server.mjs") })
  }
  if (plan.preset === "netlify") {
    entries.push({ description: "Netlify function and static config output", owner: "vite-hub", path: resolve(output.root, "v1") })
  }
  return entries
}

export async function finalizeDeploymentPlanOutput(options: FinalizeDeploymentPlanOutputOptions): Promise<void> {
  const output = resolvePlanOutput(options.plan, options.rootDir, options.outputDir)
  const entry = output.entry ? resolve(output.root, output.entry) : undefined
  if (entry) {
    try {
      await access(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      throw internalErrorDiagnostics.INTERNAL_B0040({ message: "[vitehub] The " + JSON.stringify(options.plan.preset) + " preset did not emit its required entry: " + entry + "." })
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
    preset: options.plan.preset,
    runtime: options.plan.runtime,
    services: options.services ?? options.plan.services,
  }
  const manifestPath = resolve(output.root, "deployment.json")
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  if (options.plan.preset !== "netlify") return
  const functionEntry = resolve(output.root, "functions/server.mjs")
  if (output.netlifyWrapper) {
    await mkdir(dirname(functionEntry), { recursive: true })
    await writeFile(functionEntry, netlifyWrapperSource, "utf8")
    return
  }
  // A wrapper left by an earlier build would point at a missing functions-internal entry.
  const previous = await readFile(functionEntry, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (previous === netlifyWrapperSource) await rm(functionEntry)
}
