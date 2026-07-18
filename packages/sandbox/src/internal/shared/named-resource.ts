import { upperFirst } from 'scule'
import { ViteHubError } from '@vite-hub/runtime'

export function resolveNamedResourceName(feature: string, name: string | undefined) {
  if (!name)
    throw new Error(`[vitehub] ${upperFirst(feature)} name is required. An explicit name is required.`)
  return name
}

export function createUnknownNamedResourceError(feature: string, name: string) {
  return new ViteHubError(`${feature.toUpperCase()}_NOT_FOUND`, `[vitehub] Unknown ${feature} "${name}".`)
}

export function createInvalidNamedResourceError(feature: string, name: string) {
  return new Error(`[vitehub] ${upperFirst(feature)} "${name}" is invalid.`)
}
