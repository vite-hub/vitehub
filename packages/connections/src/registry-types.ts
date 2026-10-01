import type { ConnectionClient, ConnectionDefinition } from "./types.ts"

declare global {
  interface ViteHubConnectionDefinitionModules {}
}

export type ConnectionDefinitionName = keyof ViteHubConnectionDefinitionModules & string

/** The typed client for one discovered Connection. */
export type ConnectionRegistryClient<TName extends ConnectionDefinitionName, TDryRun extends boolean = false>
  = ViteHubConnectionDefinitionModules[TName] extends { default: ConnectionDefinition<infer TApis, infer TSelection> }
    ? ConnectionClient<TApis, TSelection, TDryRun>
    : ConnectionClient<object, never, TDryRun>
