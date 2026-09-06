import { sandboxErrorDiagnostics } from "../../error-diagnostics.ts"
export type DefinitionHandler = (...args: never[]) => unknown

export function assertDefinitionHandler(functionName: string, handler: unknown, label: string): asserts handler is DefinitionHandler {
  if (typeof handler !== 'function') {
    throw sandboxErrorDiagnostics.SANDBOX_C0010({ message: `[vitehub] \`${functionName}()\` requires a ${label} as the first argument.` })
  }
}

export function validateDefinitionOptions<T>(functionName: string, options: unknown, config: {
  allowedKeys?: readonly string[]
  disallowedKeys?: readonly string[]
  invalidKeysMessage: string
}): T | undefined {
  if (typeof options === 'undefined')
    return undefined
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw sandboxErrorDiagnostics.SANDBOX_C0011({ message: `[vitehub] \`${functionName}()\` accepts one options object.` })

  const invalidKeys = Object.keys(options).filter((key) => {
    if (config.allowedKeys)
      return !config.allowedKeys.includes(key)
    return config.disallowedKeys?.includes(key)
  })

  if (invalidKeys.length) {
    throw sandboxErrorDiagnostics.SANDBOX_C0012({ message: `[vitehub] \`${functionName}()\` ${config.invalidKeysMessage}. Unsupported keys: ${invalidKeys.join(', ')}.` })
  }

  return options as T
}
