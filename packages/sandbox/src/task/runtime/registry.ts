import { assertDefinitionHandler, validateDefinitionOptions } from '../internal/shared/definition'
import type {
  SandboxTaskDefinitionInput,
  SandboxTaskDefinitionFromHandler,
  SandboxTaskDefinitionOptions,
} from '../module-types'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

function createSandboxTaskDefinition<THandler extends (...args: any[]) => any>(
  functionName: 'defineSandboxTask',
  input: SandboxTaskDefinitionInput<Parameters<THandler>[0], Awaited<ReturnType<THandler>>> & { handler: THandler },
): SandboxTaskDefinitionFromHandler<THandler> {
  if (input instanceof Object && Object.hasOwn(input, 'run'))
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_C0014({ message: `[vitehub] \`${functionName}({ run })\` was renamed. Pass the Sandbox handler as \`handler\`: \`${functionName}({ handler })\`.` })
  const validated = validateDefinitionOptions<SandboxTaskDefinitionInput>(functionName, input, {
    allowedKeys: ['handler', 'timeout', 'env', 'project'],
    invalidKeysMessage: 'supports only portable Sandbox options (handler, timeout, env, project)',
  })
  if (!validated)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0072({ message: `[vitehub] \`${functionName}()\` requires an options object.` })
  if (typeof validated.project !== 'undefined' && typeof validated.project !== 'boolean')
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0073({ message: `[vitehub] \`${functionName}()\` project must be a boolean.` })
  const { project: _project, handler, ...options } = validated
  assertDefinitionHandler(functionName, handler, 'Sandbox handler in `handler`')
  return {
    handler,
    options: Object.keys(options).length ? options as SandboxTaskDefinitionOptions : undefined,
  } as SandboxTaskDefinitionFromHandler<THandler>
}

export function defineSandboxTask<THandler extends (...args: any[]) => any>(
  input: SandboxTaskDefinitionInput<Parameters<THandler>[0], Awaited<ReturnType<THandler>>> & { handler: THandler },
): SandboxTaskDefinitionFromHandler<THandler> {
  return createSandboxTaskDefinition('defineSandboxTask', input)
}
