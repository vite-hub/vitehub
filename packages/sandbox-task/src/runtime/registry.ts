import { assertDefinitionHandler, validateDefinitionOptions } from '../internal/shared/definition'
import type {
  SandboxTaskDefinitionInput,
  SandboxTaskDefinitionFromHandler,
  SandboxTaskDefinitionOptions,
} from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

function createSandboxTaskDefinition<THandler extends (...args: any[]) => any>(
  functionName: 'defineSandboxTask',
  input: SandboxTaskDefinitionInput<Parameters<THandler>[0], Awaited<ReturnType<THandler>>> & { run: THandler },
): SandboxTaskDefinitionFromHandler<THandler> {
  const validated = validateDefinitionOptions<SandboxTaskDefinitionInput>(functionName, input, {
    allowedKeys: ['run', 'timeout', 'env', 'project'],
    invalidKeysMessage: 'supports only portable Sandbox options (run, timeout, env, project)',
  })
  if (!validated)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0072({ message: `[vitehub] \`${functionName}()\` requires an options object.` })
  if (typeof validated.project !== 'undefined' && typeof validated.project !== 'boolean')
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0073({ message: `[vitehub] \`${functionName}()\` project must be a boolean.` })
  const { project: _project, run, ...options } = validated
  assertDefinitionHandler(functionName, run, 'Sandbox handler in `run`')
  return {
    run,
    options: Object.keys(options).length ? options as SandboxTaskDefinitionOptions : undefined,
  } as SandboxTaskDefinitionFromHandler<THandler>
}

export function defineSandboxTask<THandler extends (...args: any[]) => any>(
  input: SandboxTaskDefinitionInput<Parameters<THandler>[0], Awaited<ReturnType<THandler>>> & { run: THandler },
): SandboxTaskDefinitionFromHandler<THandler> {
  return createSandboxTaskDefinition('defineSandboxTask', input)
}
