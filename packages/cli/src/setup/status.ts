import { existsSync } from "node:fs"

import { deploymentPresetFromNitro, detectPreset } from "@vite-hub/internal/deployment"
import { featureHosts, featureIds, features, featureSupport, impliedFeatures } from "@vite-hub/internal/features"
import { join } from "pathe"

import type { ConfigForm, ManualReason } from "@vite-hub/internal/config-edit"
import type { DeploymentPreset } from "@vite-hub/internal/deployment"
import type { FeatureId, HostSupport } from "@vite-hub/internal/features"
import type { SetupPackageManager, SetupProject } from "./project.ts"

export interface SetupFeatureStatus {
  id: FeatureId
  enabled: "on" | "off" | "unknown"
  /** `config` when the config sets the key, `default` when it does not, `implied` when another feature turns it on. */
  reason: "config" | "default" | "implied"
  support: HostSupport | { level: "unknown", detail: string }
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
  host: { name: DeploymentPreset | "unknown", source: "config" | "env" | "default" }
  packageManager: SetupPackageManager
  features: readonly SetupFeatureStatus[]
}

type Enabled = Pick<SetupFeatureStatus, "enabled" | "reason">

const addCommands: Record<SetupPackageManager, { dev: string, prod: string }> = {
  bun: { dev: "bun add -d", prod: "bun add" },
  npm: { dev: "npm install -D", prod: "npm install" },
  pnpm: { dev: "pnpm add -D", prod: "pnpm add" },
  yarn: { dev: "yarn add -D", prod: "yarn add" },
}

function readHost(project: SetupProject, env: NodeJS.ProcessEnv): SetupStatus["host"] {
  const config = project.config
  if (config && !config.ok && config.reason !== "no-vitehub") return { name: "unknown", source: "config" }
  const site = config?.ok ? config.site : undefined
  const preset = site?.keys.preset
  const fromConfig = preset?.kind === "literal" && typeof preset.value === "string" ? deploymentPresetFromNitro(preset.value) : undefined
  if (fromConfig) return { name: fromConfig, source: "config" }
  if (preset || site?.spread) return { name: "unknown", source: "config" }
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
  if (features[id].enabledByDefault) return { enabled: "on", reason: "default" }
  const discovery = features[id].enabledByDiscovery
  const directories = project.serverDirs ?? (project.framework === "nuxt" ? undefined : [join(project.root, "server")])
  if (discovery && !directories) return { enabled: "unknown", reason: "default" }
  const discovered = discovery?.some(file => directories?.some(directory => existsSync(join(directory, file))))
  return { enabled: discovered ? "on" : "off", reason: "default" }
}

/** True when the config sets `option`, such as `blob.driver`, as a literal key of the feature object. */
function setsOption(project: SetupProject, option: string): boolean {
  const config = project.config
  if (!config?.ok) return false
  const [id, key] = option.split(".") as [string, string]
  const value = config.site.keys[id]
  if (value?.kind === "expression") return true
  const options = value?.value
  return !!options && typeof options === "object" && !Array.isArray(options) && key in options
}

function featureFix(project: SetupProject, id: FeatureId, support: SetupFeatureStatus["support"], host: SetupStatus["host"]["name"], missing: { dev: string[], prod: string[] }): string | undefined {
  const commands = addCommands[project.packageManager]
  const installs = [
    ...(missing.prod.length ? [`${commands.prod} ${missing.prod.join(" ")}`] : []),
    ...(missing.dev.length ? [`${commands.dev} ${missing.dev.join(" ")}`] : []),
  ]
  if (installs.length) return installs.join(" && ")
  if (support.level === "unsupported") return `Set \`${id}: false\`, or build for another preset than ${host}.`
  if (support.level === "explicit" && !setsOption(project, support.option)) return `Set \`${support.option}\` in vitehub() to choose a provider on ${host}.`
}

/** What the project enables, on which host, and what each enabled feature still needs. Reads the config without running it. */
export function setupStatus(project: SetupProject, env: NodeJS.ProcessEnv): SetupStatus {
  const host = readHost(project, env)
  const enabled = new Map(featureIds.map(id => [id, readEnabled(project, id)]))
  const on = featureIds.filter(id => enabled.get(id)!.enabled === "on")
  // An implication never overrides a key that the config sets to `false` or to an expression.
  const keep = featureIds.filter(id => enabled.get(id)!.enabled !== "on" && enabled.get(id)!.reason === "config")
  const maybeOn = featureIds.filter(id => enabled.get(id)!.enabled !== "off")
  const disabled = keep.filter(id => enabled.get(id)!.enabled === "off")
  const hosts = host.name === "unknown" ? featureHosts.filter(name => name !== "dev") : [host.name]
  const definite = hosts.map(name => impliedFeatures(on, name, keep))
  const possible = new Set(hosts.flatMap(name => impliedFeatures(maybeOn, name, disabled)))
  for (const id of possible) {
    const state = enabled.get(id)!
    if (state.enabled === "off" && state.reason === "default") {
      enabled.set(id, { enabled: definite.every(ids => ids.includes(id)) ? "on" : "unknown", reason: "implied" })
    }
  }

  const config: SetupStatus["config"] = !project.config
    ? { manual: "no-vitehub" }
    : project.config.ok
      ? { file: project.configFile!, form: project.config.site.form }
      : { file: project.configFile!, manual: project.config.reason, ...(project.config.line === undefined ? {} : { line: project.config.line }) }

  return {
    config,
    features: featureIds.map((id) => {
      const state = enabled.get(id)!
      const support: SetupFeatureStatus["support"] = host.name === "unknown"
        ? { level: "unknown", detail: "The config does not statically identify the deployment host." }
        : featureSupport(id, host.name)
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
