export type DefinitionHandler = (...args: never[]) => unknown

export function assertDefinitionHandler(functionName: string, handler: unknown, label: string): asserts handler is DefinitionHandler {
  if (typeof handler !== 'function') {
    throw new TypeError(`[vitehub] \`${functionName}()\` requires a ${label} as the first argument.`)
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
    throw new TypeError(`[vitehub] \`${functionName}()\` accepts \`(handler, options?)\`.`)

  const invalidKeys = Object.keys(options).filter((key) => {
    if (config.allowedKeys)
      return !config.allowedKeys.includes(key)
    return config.disallowedKeys?.includes(key)
  })

  if (invalidKeys.length) {
    throw new TypeError(
      `[vitehub] \`${functionName}()\` ${config.invalidKeysMessage}. Unsupported keys: ${invalidKeys.join(', ')}.`,
    )
  }

  return options as T
}
