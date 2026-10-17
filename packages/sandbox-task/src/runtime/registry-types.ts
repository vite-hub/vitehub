import type { SandboxTaskDefinitionModules } from '#vitehub-sandbox-task-registry'

export type SandboxTaskDefinitionName = keyof SandboxTaskDefinitionModules

export type SandboxTaskRegistryDefinition<TName extends keyof SandboxTaskDefinitionModules>
  = SandboxTaskDefinitionModules[TName]

export type SandboxTaskPayload<TDefinition>
  = TDefinition extends { payload: infer TPayload } ? TPayload : unknown
