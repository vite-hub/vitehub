import { access, mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"

import type { DeploymentPlan } from "../deployment.ts"

interface FinalizeDeploymentPlanOutputOptions {
  outputDir?: string
  plan: DeploymentPlan
  rootDir: string
  services?: object
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
      throw new Error("[vitehub] The " + JSON.stringify(options.plan.preset) + " preset did not emit its required entry: " + entry + ".")
    }
  }
  const manifest = {
    host: options.plan.host,
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
}
