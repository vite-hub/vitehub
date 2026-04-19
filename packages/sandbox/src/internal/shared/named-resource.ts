import { upperFirst } from 'scule'

export function resolveNamedResourceName(feature: string, name: string | undefined) {
  if (!name)
    throw new Error(`[vitehub] ${upperFirst(feature)} name is required. Pass an explicit name.`)
  return name
}

export function createUnknownNamedResourceError(feature: string, name: string) {
  return new Error(`[vitehub] Unknown ${feature} "${name}".`)
}

export function createInvalidNamedResourceError(feature: string, name: string) {
  return new Error(`[vitehub] ${upperFirst(feature)} "${name}" is invalid.`)
}
