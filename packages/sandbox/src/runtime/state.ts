import type { AgentSandboxConfig } from '../module-types'
import type { SandboxDefinitionBundle, SandboxDefinitionOptions } from '../module-types'

export type SandboxRegistryEntry = {
  bundle: SandboxDefinitionBundle
  options?: SandboxDefinitionOptions
}

export type SandboxRuntimeRegistry = Record<string, SandboxRegistryEntry | (() => Promise<{ default?: SandboxRegistryEntry }>)>
type GeneratedSandboxRuntimeRegistryEntry = {
  load: () => Promise<{ default?: SandboxRegistryEntry }>
  stablePath: string
}
type GeneratedSandboxRuntimeRegistry = Record<string, GeneratedSandboxRuntimeRegistryEntry>

let sandboxConfig: false | AgentSandboxConfig | undefined
let sandboxRegistry: SandboxRuntimeRegistry | undefined
const generatedRegistries = new Map<string, GeneratedSandboxRuntimeRegistry>()

function isMissingGeneratedSandboxModule(error: unknown) {
  const code = Reflect.get(Object(error), 'code')
  return code === 'ENOENT' || code === 'ERR_MODULE_NOT_FOUND'
}

export function createGeneratedSandboxRuntimeRegistry(
  scope: string,
  registry: GeneratedSandboxRuntimeRegistry,
): SandboxRuntimeRegistry {
  generatedRegistries.set(scope, registry)
  return Object.fromEntries(Object.keys(registry).map(name => [name, async () => {
    const entry = generatedRegistries.get(scope)?.[name]
    if (!entry)
      throw new Error(`[vitehub] Sandbox definition "${name}" is no longer generated.`)
    try {
      return await entry.load()
    }
    catch (error) {
      if (!isMissingGeneratedSandboxModule(error))
        throw error
      return await import(/* @vite-ignore */ entry.stablePath)
    }
  }]))
}

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
