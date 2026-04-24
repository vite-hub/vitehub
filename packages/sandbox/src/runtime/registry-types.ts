import type { SandboxDefinitionModules } from '#vitehub-sandbox-registry'

export type SandboxDefinitionName = keyof SandboxDefinitionModules

export type SandboxRegistryDefinition<TName extends keyof SandboxDefinitionModules>
  = SandboxDefinitionModules[TName] extends { default?: infer TDefinition } ? NonNullable<TDefinition> : never

export type SandboxRunner<TDefinition>
  = TDefinition extends { run: infer TRun extends (...args: any[]) => any } ? TRun : never

export type SandboxPayload<TDefinition>
  = SandboxRunner<TDefinition> extends (...args: infer TArgs) => unknown ? TArgs[0] : unknown

export type SandboxResult<TDefinition>
  = SandboxRunner<TDefinition> extends (...args: any[]) => infer TResult ? Awaited<TResult> : unknown
