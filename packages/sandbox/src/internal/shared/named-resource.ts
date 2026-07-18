import { upperFirst } from 'scule'
import { VitehubError } from './errors'

export function resolveNamedResourceName(feature: string, name: string | undefined) {
  if (!name)
    throw new Error(`[vitehub] ${upperFirst(feature)} name is required. An explicit name is required.`)
  return name
}

export function createUnknownNamedResourceError(feature: string, name: string) {
  return new VitehubError(`[vitehub] Unknown ${feature} "${name}".`, { code: `${feature.toUpperCase()}_NOT_FOUND` })
}

export function createInvalidNamedResourceError(feature: string, name: string) {
  return new Error(`[vitehub] ${upperFirst(feature)} "${name}" is invalid.`)
}
