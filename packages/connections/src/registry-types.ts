import type { ConnectionClient, ConnectionDefinition, ConnectionInstancesDefinition } from "./types.ts"

declare global {
  interface ViteHubConnectionDefinitionModules {}
}

type Modules = ViteHubConnectionDefinitionModules

/** Each instance of a keyed Connection Definition, as `<name>:<instance>`. */
type InstanceNames = {
  [TName in keyof Modules & string]: Modules[TName] extends { default: ConnectionInstancesDefinition<infer TInstance> } ? `${TName}:${TInstance}` : never
}[keyof Modules & string]

/** Discovered Connection names. A keyed definition contributes one name per instance instead of its file name. */
export type ConnectionDefinitionName = {
  [TName in keyof Modules & string]: Modules[TName] extends { default: ConnectionInstancesDefinition } ? never : TName
}[keyof Modules & string] | InstanceNames

/** The definition behind a discovered Connection name, including an instance of a keyed definition. */
type DefinitionOf<TName extends string> = TName extends keyof Modules
  ? Modules[TName] extends { default: infer TDefinition } ? TDefinition : never
  : TName extends `${infer TGroup}:${string}`
    ? TGroup extends keyof Modules
      ? Modules[TGroup] extends { default: ConnectionInstancesDefinition<string, infer TDefinition> } ? TDefinition : never
      : never
    : never

/** The typed client for one discovered Connection. */
export type ConnectionRegistryClient<TName extends ConnectionDefinitionName, TDryRun extends boolean = false>
  = DefinitionOf<TName> extends ConnectionDefinition<infer TApis, infer TSelection>
    ? ConnectionClient<TApis, TSelection, TDryRun>
    : ConnectionClient<object, never, TDryRun>
