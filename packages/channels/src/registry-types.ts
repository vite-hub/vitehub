import type { ChannelConnectorMap, ChannelDefinition } from "./types.ts"

declare global {
  interface ViteHubChannelDefinitionModules {}
}

export type ChannelDefinitionName = keyof ViteHubChannelDefinitionModules & string

export type ChannelRegistryDefinition<TName extends ChannelDefinitionName>
  = ViteHubChannelDefinitionModules[TName] extends { default?: infer TDefinition }
    ? NonNullable<TDefinition>
    : never

export type ChannelDefinitionConnectors<TDefinition>
  = TDefinition extends ChannelDefinition<infer TConnectors, any> ? TConnectors : ChannelConnectorMap

export type ChannelDefinitionDefault<TDefinition>
  = TDefinition extends ChannelDefinition<infer TConnectors, infer TDefault>
    ? TDefault & keyof TConnectors & string
    : never

