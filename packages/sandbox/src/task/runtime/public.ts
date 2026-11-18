export { defineSandboxTask } from './registry'
export type { SandboxTaskExecutionOptions, SandboxTaskRunResult } from '../module-types'
import type { SandboxTaskRunArguments } from '../module-types'
import { runSandboxTaskRuntime } from './runtime'
import type {
  SandboxTaskDefinitionName,
  SandboxTaskPayload,
  SandboxTaskRegistryDefinition,
  SandboxTaskResult,
} from './registry-types'

/**
 * Run a Sandbox Task by its name. `data` is the value that the handler returned, such as a JSON value or a native
 * `Response`. A failed run returns `SANDBOX_TASK_RUN_FAILED`, and `toResponse(error)` answers with its status.
 */
export function runSandboxTask<const TName extends string>(
  name: TName,
  ...args: SandboxTaskRunArguments<TName extends SandboxTaskDefinitionName
    ? SandboxTaskPayload<SandboxTaskRegistryDefinition<TName>>
    : unknown>
): Promise<import('../module-types').SandboxTaskRunResult<TName extends SandboxTaskDefinitionName
  ? SandboxTaskResult<SandboxTaskRegistryDefinition<TName>>
  : unknown>>
export async function runSandboxTask(
  name: string | undefined,
  payload?: unknown,
  options?: import('../module-types').SandboxTaskExecutionOptions,
) {
  return await runSandboxTaskRuntime(name, payload, options)
}
