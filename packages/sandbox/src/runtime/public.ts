export { defineSandbox } from './registry'
export { SandboxError } from '../sandbox/errors'
export type { SandboxExecutionOptions, SandboxRunResult } from '../module-types'
import { runSandbox as runSandboxRuntime } from './runtime'
import type {
  SandboxDefinitionName,
  SandboxPayload,
  SandboxRegistryDefinition,
  SandboxResult,
} from './registry-types'

export function runSandbox<const TName extends SandboxDefinitionName>(
  name: TName,
  payload?: SandboxPayload<SandboxRegistryDefinition<TName>>,
  options?: import('../module-types').SandboxExecutionOptions,
): Promise<import('../module-types').SandboxRunResult<SandboxResult<SandboxRegistryDefinition<TName>>>>
export function runSandbox(
  name: string,
  payload?: unknown,
  options?: import('../module-types').SandboxExecutionOptions,
): Promise<import('../module-types').SandboxRunResult<unknown>>
export async function runSandbox(
  name: string | undefined,
  payload?: unknown,
  options?: import('../module-types').SandboxExecutionOptions,
) {
  return await runSandboxRuntime(name, payload, options)
}
