import type { AgentSandboxConfig } from '../module-types'
import type { SandboxDefinitionBundle, SandboxDefinitionOptions } from '../module-types'

export type SandboxRegistryEntry = {
  bundle: SandboxDefinitionBundle
  options?: SandboxDefinitionOptions
}

export type SandboxRuntimeRegistry = Record<string, SandboxRegistryEntry | (() => Promise<{ default?: SandboxRegistryEntry }>)>

let sandboxConfig: false | AgentSandboxConfig | undefined
let sandboxRegistry: SandboxRuntimeRegistry | undefined

export function getSandboxRuntimeConfig() {
  return sandboxConfig
}

export function getSandboxRuntimeRegistry() {
  return sandboxRegistry
}

export function setSandboxRuntimeConfig(config: false | AgentSandboxConfig | undefined) {
  sandboxConfig = config
}

export function setSandboxRuntimeRegistry(registry: SandboxRuntimeRegistry | undefined) {
  sandboxRegistry = registry
}

export function resetSandboxRuntimeState() {
  sandboxConfig = undefined
  sandboxRegistry = undefined
}
