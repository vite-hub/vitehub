import { access, mkdir, writeFile } from "node:fs/promises"
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

/**
 * Lists the Provider Output that a Deployment Plan writes, for `vitehub inspect provider-output`.
 * Paths use the resolved Nitro output directory when the host provides one.
 */
export function describeDeploymentPlanOutput(plan: DeploymentPlan, rootDir: string, outputDir?: string): ViteHubProviderOutputEntry[] {
  const nitroOutputRoot = resolve(rootDir, outputDir ?? plan.output.directory)
  const outputRoot = plan.preset === "netlify" && basename(nitroOutputRoot) === "functions-internal"
    ? dirname(nitroOutputRoot)
    : nitroOutputRoot
  const entries: ViteHubProviderOutputEntry[] = [
    { description: "Deployment manifest with host, runtime, output, and services", owner: "vite-hub", path: resolve(outputRoot, "deployment.json") },
  ]
  if (plan.preset === "cloudflare") {
    entries.push({ description: "Generated Cloudflare Worker config", owner: "vite-hub", path: resolve(outputRoot, "server/wrangler.json") })
  }
  if (plan.preset === "vercel") {
    entries.push({ description: "Vercel Build Output config", owner: "vite-hub", path: resolve(outputRoot, "config.json") })
  }
  if (plan.preset === "netlify") {
    entries.push({ description: "Nitro Netlify server functions", owner: "vite-hub", path: resolve(rootDir, outputDir ?? resolve(outputRoot, "functions-internal")) })
    entries.push({ description: "Netlify function entrypoint", owner: "vite-hub", path: resolve(outputRoot, "functions/server.mjs") })
    entries.push({ description: "Netlify function and static config output", owner: "vite-hub", path: resolve(outputRoot, "v1") })
  }
  return entries
}

export async function finalizeDeploymentPlanOutput(options: FinalizeDeploymentPlanOutputOptions): Promise<void> {
  const nitroOutputRoot = resolve(options.rootDir, options.outputDir ?? options.plan.output.directory)
  const outputRoot = options.plan.preset === "netlify" && basename(nitroOutputRoot) === "functions-internal"
    ? dirname(nitroOutputRoot)
    : nitroOutputRoot
  const entry = options.plan.output.entry ? resolve(outputRoot, options.plan.output.entry) : undefined
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
      directory: relative(options.rootDir, outputRoot).replaceAll("\\", "/") || ".",
    },
    preset: options.plan.preset,
    runtime: options.plan.runtime,
    services: options.services ?? options.plan.services,
  }
  const manifestPath = resolve(outputRoot, "deployment.json")
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  if (options.plan.preset === "netlify") {
    const functionEntry = resolve(outputRoot, "functions/server.mjs")
    await mkdir(dirname(functionEntry), { recursive: true })
    await writeFile(functionEntry, 'export { default } from "../functions-internal/server/server.mjs"\n', "utf8")
  }
}
