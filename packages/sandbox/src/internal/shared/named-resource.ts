import { sandboxErrorDiagnostics } from "../../error-diagnostics.ts"

function upperFirst(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function resolveNamedResourceName(feature: string, name: string | undefined) {
  if (!name)
    throw sandboxErrorDiagnostics.SANDBOX_R0052({ message: `[vitehub] ${upperFirst(feature)} name is required. An explicit name is required.` })
  return name
}

export function createUnknownNamedResourceError(feature: string, name: string) {
  return sandboxErrorDiagnostics.SANDBOX_R0053({ message: `[vitehub] Unknown ${feature} "${name}".` })
}

export function createInvalidNamedResourceError(feature: string, name: string) {
  return sandboxErrorDiagnostics.SANDBOX_R0054({ message: `[vitehub] ${upperFirst(feature)} "${name}" is invalid.` })
}
