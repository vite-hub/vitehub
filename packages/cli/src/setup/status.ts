import { deploymentPresetFromNitro, detectPreset } from "@vite-hub/internal/deployment"
import { featureIds, features, featureSupport, impliedFeatures } from "@vite-hub/internal/features"

import type { ConfigForm, ConfigValue, ManualReason } from "@vite-hub/internal/config-edit"
import type { DeploymentPreset } from "@vite-hub/internal/deployment"
import type { FeatureId, HostSupport } from "@vite-hub/internal/features"
import type { SetupPackageManager, SetupProject } from "./project.ts"

export interface SetupFeatureStatus {
  id: FeatureId
  enabled: "on" | "off" | "unknown"
  /** `config` when the config sets the key, `default` when it does not, `implied` when another feature turns it on. */
  reason: "config" | "default" | "implied"
  support: HostSupport
  /** Packages and development packages of an enabled feature that are not installed. */
  missingPackages: readonly string[]
  /** The next step, such as the install command of `missingPackages`. */
  fix?: string
}

export interface SetupStatus {
  schemaVersion: 1
  root: string
  framework: SetupProject["framework"]
  config: { file: string, form: ConfigForm } | { file?: string, manual: ManualReason, line?: number }
  host: { name: DeploymentPreset, source: "config" | "env" | "default" }
  packageManager: SetupPackageManager
  features: readonly SetupFeatureStatus[]
}

type Enabled = Pick<SetupFeatureStatus, "enabled" | "reason">

const addArgs: Record<SetupPackageManager, { dev: readonly string[], prod: readonly string[] }> = {
  bun: { dev: ["add", "-d"], prod: ["add"] },
  npm: { dev: ["install", "-D"], prod: ["install"] },
  pnpm: { dev: ["add", "-D"], prod: ["add"] },
  yarn: { dev: ["add", "-D"], prod: ["add"] },
}

/** The arguments of the `packageManager` command that installs `packages`, such as `["add", "-D", "drizzle-kit"]`. */
export function installArgs(packageManager: SetupPackageManager, packages: readonly string[], dev: boolean): string[] {
  return [...addArgs[packageManager][dev ? "dev" : "prod"], ...packages]
}

/** The shell command that installs `prod` and then `dev`, such as `pnpm add kv && pnpm add -D drizzle-kit`. */
export function installCommand(packageManager: SetupPackageManager, prod: readonly string[], dev: readonly string[]): string | undefined {
  const commands = [
    ...(prod.length ? [[packageManager, ...installArgs(packageManager, prod, false)].join(" ")] : []),
    ...(dev.length ? [[packageManager, ...installArgs(packageManager, dev, true)].join(" ")] : []),
  ]
  return commands.length ? commands.join(" && ") : undefined
}

function readHost(keys: Readonly<Record<string, ConfigValue>> | undefined, env: NodeJS.ProcessEnv): SetupStatus["host"] {
  const preset = keys?.preset
  const fromConfig = preset?.kind === "literal" && typeof preset.value === "string" ? deploymentPresetFromNitro(preset.value) : undefined
  if (fromConfig) return { name: fromConfig, source: "config" }
  const fromEnv = detectPreset(env)
  return fromEnv ? { name: fromEnv, source: "env" } : { name: "node", source: "default" }
}

function readEnabled(project: SetupProject, id: FeatureId): Enabled {
  const config = project.config
  if (!config || (!config.ok && config.reason === "no-vitehub")) return { enabled: "off", reason: "default" }
  if (!config.ok) return { enabled: "unknown", reason: "config" }
  const value = config.site.keys[id]
  if (value?.kind === "expression") return { enabled: "unknown", reason: "config" }
  if (value) return { enabled: value.value === false ? "off" : "on", reason: "config" }
  if (config.site.spread) return { enabled: "unknown", reason: "config" }
  return { enabled: features[id].enabledByDefault ? "on" : "off", reason: "default" }
}

/** True when the config sets `option`, such as `blob.driver`, as a literal key of the feature object. */
export function setsOption(project: SetupProject, option: string): boolean {
  const config = project.config
  if (!config?.ok) return false
  const [id, key] = option.split(".") as [string, string]
  const value = config.site.keys[id]
  if (value?.kind === "expression") return true
  const options = value?.value
  return !!options && typeof options === "object" && !Array.isArray(options) && key in options
}

function featureFix(project: SetupProject, id: FeatureId, support: HostSupport, host: DeploymentPreset, missing: { dev: string[], prod: string[] }): string | undefined {
  const install = installCommand(project.packageManager, missing.prod, missing.dev)
  if (install) return install
  if (support.level === "unsupported") return `Set \`${id}: false\`, or build for another preset than ${host}.`
  if (support.level === "explicit" && !setsOption(project, support.option)) return `Set \`${support.option}\` in vitehub() to choose a provider on ${host}.`
}

/** What the project enables, on which host, and what each enabled feature still needs. Reads the config without running it. */
export function setupStatus(project: SetupProject, env: NodeJS.ProcessEnv): SetupStatus {
  const site = project.config?.ok ? project.config.site : undefined
  const host = readHost(site?.keys, env)
  const enabled = new Map(featureIds.map(id => [id, readEnabled(project, id)]))
  const on = featureIds.filter(id => enabled.get(id)!.enabled === "on")
  // An implication never overrides a key that the config sets to `false` or to an expression.
  const keep = featureIds.filter(id => enabled.get(id)!.enabled !== "on" && enabled.get(id)!.reason === "config")
  for (const id of impliedFeatures(on, host.name, keep)) enabled.set(id, { enabled: "on", reason: "implied" })

  const config: SetupStatus["config"] = !project.config
    ? { manual: "no-vitehub" }
    : project.config.ok
      ? { file: project.configFile!, form: project.config.site.form }
      : { file: project.configFile!, manual: project.config.reason, ...(project.config.line === undefined ? {} : { line: project.config.line }) }

  return {
    config,
    features: featureIds.map((id) => {
      const state = enabled.get(id)!
      const support = featureSupport(id, host.name)
      const definition = features[id]
      const missing = state.enabled === "on"
        ? { dev: definition.devPackages.filter(name => !project.installed(name)), prod: definition.packages.filter(name => !project.installed(name)) }
        : { dev: [], prod: [] }
      const fix = state.enabled === "on" ? featureFix(project, id, support, host.name, missing) : undefined
      return { id, ...state, missingPackages: [...missing.prod, ...missing.dev], support, ...(fix ? { fix } : {}) }
    }),
    framework: project.framework,
    host,
    packageManager: project.packageManager,
    root: project.root,
    schemaVersion: 1,
  }
}
