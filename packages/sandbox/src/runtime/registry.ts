import { assertDefinitionHandler, validateDefinitionOptions } from '../internal/shared/definition'
import type {
  SandboxDefinitionInput,
  SandboxDefinitionFromHandler,
  SandboxDefinitionOptions,
} from '../module-types'
import { sandboxErrorDiagnostics } from "../error-diagnostics.ts"

function createSandboxDefinition<THandler extends (...args: any[]) => any>(
  functionName: 'defineSandbox',
  input: SandboxDefinitionInput<Parameters<THandler>[0], Awaited<ReturnType<THandler>>> & { run: THandler },
): SandboxDefinitionFromHandler<THandler> {
  const validated = validateDefinitionOptions<SandboxDefinitionInput>(functionName, input, {
    allowedKeys: ['run', 'timeout', 'env', 'project'],
    invalidKeysMessage: 'supports only portable Sandbox options (run, timeout, env, project)',
  })
  if (!validated)
    throw sandboxErrorDiagnostics.SANDBOX_R0072({ message: `[vitehub] \`${functionName}()\` requires an options object.` })
  if (typeof validated.project !== 'undefined' && typeof validated.project !== 'boolean')
    throw sandboxErrorDiagnostics.SANDBOX_R0073({ message: `[vitehub] \`${functionName}()\` project must be a boolean.` })
  const { project: _project, run, ...options } = validated
  assertDefinitionHandler(functionName, run, 'Sandbox handler in `run`')
  return {
    run,
    options: Object.keys(options).length ? options as SandboxDefinitionOptions : undefined,
  } as SandboxDefinitionFromHandler<THandler>
}

export function defineSandbox<THandler extends (...args: any[]) => any>(
  input: SandboxDefinitionInput<Parameters<THandler>[0], Awaited<ReturnType<THandler>>> & { run: THandler },
): SandboxDefinitionFromHandler<THandler> {
  return createSandboxDefinition('defineSandbox', input)
}
