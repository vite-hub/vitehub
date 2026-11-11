export { defineSandboxTask } from './registry'
export type { SandboxTaskExecutionOptions, SandboxTaskRunResult } from '../module-types'
import type { SandboxTaskRunArguments } from '../module-types'
import { runSandboxTaskRuntime } from './runtime'
import type {
  SandboxTaskDefinitionName,
  SandboxTaskPayload,
  SandboxTaskRegistryDefinition,
} from './registry-types'

export function runSandboxTask<const TName extends string>(
  name: TName,
  ...args: SandboxTaskRunArguments<TName extends SandboxTaskDefinitionName
    ? SandboxTaskPayload<SandboxTaskRegistryDefinition<TName>>
    : unknown>
): Promise<import('../module-types').SandboxTaskRunResult>
export async function runSandboxTask(
  name: string | undefined,
  payload?: unknown,
  options?: import('../module-types').SandboxTaskExecutionOptions,
) {
  return await runSandboxTaskRuntime(name, payload, options)
}
