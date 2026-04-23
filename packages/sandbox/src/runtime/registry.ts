import { assertDefinitionHandler, validateDefinitionOptions } from '../internal/shared/definition'
import type {
  SandboxDefinitionFromHandler,
  SandboxDefinitionOptions,
  SandboxDefinitionRuntime,
} from '../module-types'

function validateRuntimeOptions(functionName: string, runtime: unknown): SandboxDefinitionRuntime | undefined {
  if (typeof runtime === 'undefined')
    return undefined
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new TypeError(`[vitehub] \`${functionName}()\` expects \`options.runtime\` to be an object with \`command\` and optional \`args\`.`)
  }

  const { command, args, ...rest } = runtime as Record<string, unknown>
  const invalidKeys = Object.keys(rest)
  if (invalidKeys.length > 0) {
    throw new TypeError(`[vitehub] \`${functionName}()\` supports only \`options.runtime.command\` and \`options.runtime.args\`. Unsupported keys: ${invalidKeys.join(', ')}.`)
  }
  if (typeof command !== 'string' || !command.trim()) {
    throw new TypeError(`[vitehub] \`${functionName}()\` expects \`options.runtime.command\` to be a non-empty string.`)
  }
  if (typeof args !== 'undefined' && (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))) {
    throw new TypeError(`[vitehub] \`${functionName}()\` expects \`options.runtime.args\` to be a string array.`)
  }

  return {
    command,
    ...(Array.isArray(args) ? { args: [...args] } : {}),
  }
}

function createSandboxDefinition<THandler extends (...args: any[]) => any>(
  functionName: 'defineSandbox',
  run: THandler,
  options?: SandboxDefinitionOptions,
): SandboxDefinitionFromHandler<THandler> {
  const validated = validateDefinitionOptions<SandboxDefinitionOptions>(functionName, options, {
    allowedKeys: ['timeout', 'env', 'runtime'],
    invalidKeysMessage: 'supports only portable sandbox options (timeout, env, runtime)',
  })

  assertDefinitionHandler(functionName, run, 'sandbox handler')
  return {
    run,
    options: validated
      ? {
          ...validated,
          runtime: validateRuntimeOptions(functionName, validated.runtime),
        }
      : undefined,
  } as SandboxDefinitionFromHandler<THandler>
}

export function defineSandbox<THandler extends (...args: any[]) => any>(
  run: THandler,
  options?: SandboxDefinitionOptions,
): SandboxDefinitionFromHandler<THandler> {
  return createSandboxDefinition('defineSandbox', run, options)
}
