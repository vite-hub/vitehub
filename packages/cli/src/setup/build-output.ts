import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { isRecord, optionalString } from "./deploy/host.ts"
import { setupFailure, setupExitCodes } from "./envelope.ts"

import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { DeployHost } from "./deploy/host.ts"
import type { SetupProject } from "./project.ts"

/** Runs the build script for `host`. VITEHUB_HOST_SOURCE=cli makes `host` win over a `host` literal in vitehub(). */
export async function build(project: SetupProject, host: DeployHost, context: ViteHubCliContext): Promise<void> {
  const command = `${project.packageManager} run build`
  const manifest: unknown = existsSync(join(project.root, "package.json")) ? JSON.parse(await readFile(join(project.root, "package.json"), "utf8")) : undefined
  if (!isRecord(manifest) || !isRecord(manifest.scripts) || typeof manifest.scripts.build !== "string") {
    throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_BUILD_FAILED({ command }), setupExitCodes.error)
  }
  const env = { ...context.env, VITEHUB_HOST: host, VITEHUB_HOST_SOURCE: "cli" }
  const result = await context.spawn(project.packageManager, ["run", "build"], { cwd: project.root, env, stdout: "stderr" })
  if (result.exitCode !== 0) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_BUILD_FAILED({ command, exitCode: result.exitCode ?? result.signal }), setupExitCodes.error)
}

export interface BuildOutput {
  outputDir: string
  identityName?: string
  /** The host variable names that the app reads, from `env` of `deployment.json`. Empty when the build lists none. */
  env: DeploymentEnvEntry[]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : []
}

/** One entry of `env` in `deployment.json`. Only names: the build never writes a value there. */
function readEnvEntry(value: unknown): DeploymentEnvEntry[] {
  if (!isRecord(value)) return []
  const names = stringList(value.names)
  const prefix = optionalString(value.prefix)
  if (!names.length && !prefix) return []
  const owners = stringList(value.owners)
  const path = optionalString(value.path)
  return [{
    ...(path ? { path } : {}),
    names,
    ...(prefix ? { prefix } : {}),
    required: value.required === true,
    secret: value.secret === true,
    hasDefault: value.hasDefault === true,
    ...(owners.length ? { owners } : {}),
  }]
}

/** Reads `<output>/deployment.json`, which the build writes, and checks that it is for `host`. */
export async function readBuildOutput(root: string, host: DeployHost): Promise<BuildOutput> {
  const outputDir = join(root, resolveDeploymentPlan(host).output.directory)
  const file = join(outputDir, "deployment.json")
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(file, "utf8"))
  }
  catch {
    throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file }), setupExitCodes.error)
  }
  const built = isRecord(manifest) ? optionalString(manifest.host) : undefined
  if (built !== host) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_HOST_MISMATCH({ built: built ?? "an unknown host", host }), setupExitCodes.conflict)
  const identityName = isRecord(manifest) && isRecord(manifest.identity) ? optionalString(manifest.identity.name) : undefined
  const env = isRecord(manifest) && Array.isArray(manifest.env) ? manifest.env.flatMap(readEnvEntry) : []
  return { env, outputDir, ...(identityName ? { identityName } : {}) }
}
