import { pathToFileURL } from 'node:url'

import type { AgentSandboxTaskConfig } from '../module-types'
import type { SandboxTaskDefinitionBundle, SandboxTaskDefinitionOptions } from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

export type SandboxTaskRegistryEntry = {
  bundle: SandboxTaskDefinitionBundle
  options?: SandboxTaskDefinitionOptions
}

export type SandboxTaskRuntimeRegistry = Record<string, SandboxTaskRegistryEntry | (() => Promise<{ default?: SandboxTaskRegistryEntry }>)>
type GeneratedSandboxTaskRuntimeRegistryEntry = {
  load: () => Promise<{ default?: SandboxTaskRegistryEntry }>
  stablePath: string
}
type GeneratedSandboxTaskRuntimeRegistry = Record<string, GeneratedSandboxTaskRuntimeRegistryEntry>

let sandboxTaskConfig: false | AgentSandboxTaskConfig | undefined
let sandboxTaskRegistry: SandboxTaskRuntimeRegistry | undefined
const generatedRegistries = new Map<string, GeneratedSandboxTaskRuntimeRegistry>()
const generatedRegistryOwnership = new WeakMap<SandboxTaskRuntimeRegistry, { registry: GeneratedSandboxTaskRuntimeRegistry, scope: string }>()
let generatedRegistryRecoveryId = 0

function isMissingGeneratedSandboxTaskModule(error: unknown) {
  const code = Reflect.get(Object(error), 'code')
  return code === 'ENOENT' || code === 'ERR_MODULE_NOT_FOUND'
}

export function createGeneratedSandboxTaskModuleSpecifier(path: string, recover = false) {
  const normalizedPath = path.replaceAll('\\', '/')
  const url = normalizedPath.startsWith('file:') ? new URL(normalizedPath) : pathToFileURL(normalizedPath)
  if (recover)
    url.searchParams.set('vitehub-recovery', String(++generatedRegistryRecoveryId))
  return url.href
}

async function loadActiveGeneratedSandboxTaskDefinition(scope: string, name: string) {
  const activeModule = await import(/* @vite-ignore */ createGeneratedSandboxTaskModuleSpecifier(scope, true))
  const activeEntry = activeModule.default?.[name] as SandboxTaskRuntimeRegistry[string] | undefined
  if (!activeEntry)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0074({ message: `[vitehub] Sandbox Task Definition "${name}" is no longer generated.` })
  return typeof activeEntry === 'function' ? await activeEntry() : { default: activeEntry }
}

export function createGeneratedSandboxTaskRuntimeRegistry(
  scope: string,
  registry: GeneratedSandboxTaskRuntimeRegistry,
): SandboxTaskRuntimeRegistry {
  const runtimeRegistry = Object.fromEntries(Object.keys(registry).map(name => [name, async () => {
    const activeRegistry = generatedRegistries.get(scope)
    const entry = activeRegistry === undefined ? registry[name] : activeRegistry[name]
    if (!entry)
      throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0075({ message: `[vitehub] Sandbox Task Definition "${name}" is no longer generated.` })
    try {
      return await entry.load()
    }
    catch (error) {
      if (!isMissingGeneratedSandboxTaskModule(error))
        throw error
      try {
        return await import(/* @vite-ignore */ createGeneratedSandboxTaskModuleSpecifier(entry.stablePath, true))
      }
      catch (stableError) {
        if (!isMissingGeneratedSandboxTaskModule(stableError))
          throw stableError
        return await loadActiveGeneratedSandboxTaskDefinition(scope, name)
      }
    }
  }]))
  generatedRegistryOwnership.set(runtimeRegistry, { registry, scope })
  return runtimeRegistry
}

export function getSandboxTaskRuntimeConfig() {
  return sandboxTaskConfig
}

export function getSandboxTaskRuntimeRegistry() {
  return sandboxTaskRegistry
}

export function setSandboxTaskRuntimeConfig(config: false | AgentSandboxTaskConfig | undefined) {
  sandboxTaskConfig = config
}

export function setSandboxTaskRuntimeRegistry(registry: SandboxTaskRuntimeRegistry | undefined) {
  sandboxTaskRegistry = registry
  const generated = registry && generatedRegistryOwnership.get(registry)
  if (generated)
    generatedRegistries.set(generated.scope, generated.registry)
}

export function resetSandboxTaskRuntimeState() {
  sandboxTaskConfig = undefined
  sandboxTaskRegistry = undefined
  generatedRegistries.clear()
}
