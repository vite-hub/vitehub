import type { SandboxDefinitionModules } from '#vitehub-sandbox-registry'

export type SandboxDefinitionName = keyof SandboxDefinitionModules

export type SandboxRegistryDefinition<TName extends keyof SandboxDefinitionModules>
  = SandboxDefinitionModules[TName]

export type SandboxPayload<TDefinition>
  = TDefinition extends { payload: infer TPayload } ? TPayload : unknown
