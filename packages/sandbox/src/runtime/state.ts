import { pathToFileURL } from 'node:url'

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
const generatedRegistryOwnership = new WeakMap<SandboxRuntimeRegistry, { registry: GeneratedSandboxRuntimeRegistry, scope: string }>()
let generatedRegistryRecoveryId = 0

function isMissingGeneratedSandboxModule(error: unknown) {
  const code = Reflect.get(Object(error), 'code')
  return code === 'ENOENT' || code === 'ERR_MODULE_NOT_FOUND'
}

export function createGeneratedSandboxModuleSpecifier(path: string, recover = false) {
  const normalizedPath = path.replaceAll('\\', '/')
  const url = normalizedPath.startsWith('file:') ? new URL(normalizedPath) : pathToFileURL(normalizedPath)
  if (recover)
    url.searchParams.set('vitehub-recovery', String(++generatedRegistryRecoveryId))
  return url.href
}

async function loadActiveGeneratedSandboxDefinition(scope: string, name: string) {
  const activeModule = await import(/* @vite-ignore */ createGeneratedSandboxModuleSpecifier(scope, true))
  const activeEntry = activeModule.default?.[name] as SandboxRuntimeRegistry[string] | undefined
  if (!activeEntry)
    throw new Error(`[vitehub] Sandbox definition "${name}" is no longer generated.`)
  return typeof activeEntry === 'function' ? await activeEntry() : { default: activeEntry }
}

export function createGeneratedSandboxRuntimeRegistry(
  scope: string,
  registry: GeneratedSandboxRuntimeRegistry,
): SandboxRuntimeRegistry {
  const runtimeRegistry = Object.fromEntries(Object.keys(registry).map(name => [name, async () => {
    const activeRegistry = generatedRegistries.get(scope)
    const entry = activeRegistry === undefined ? registry[name] : activeRegistry[name]
    if (!entry)
      throw new Error(`[vitehub] Sandbox definition "${name}" is no longer generated.`)
    try {
      return await entry.load()
    }
    catch (error) {
      if (!isMissingGeneratedSandboxModule(error))
        throw error
      try {
        return await import(/* @vite-ignore */ createGeneratedSandboxModuleSpecifier(entry.stablePath, true))
      }
      catch (stableError) {
        if (!isMissingGeneratedSandboxModule(stableError))
          throw stableError
        return await loadActiveGeneratedSandboxDefinition(scope, name)
      }
    }
  }]))
  generatedRegistryOwnership.set(runtimeRegistry, { registry, scope })
  return runtimeRegistry
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
  const generated = registry && generatedRegistryOwnership.get(registry)
  if (generated)
    generatedRegistries.set(generated.scope, generated.registry)
}

export function resetSandboxRuntimeState() {
  sandboxConfig = undefined
  sandboxRegistry = undefined
  generatedRegistries.clear()
}
