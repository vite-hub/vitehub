import type { ChannelMessage, ChannelSendOptions } from "./types.ts"

declare global {
  interface ViteHubChannelDefinitionModules {}
}

export type ChannelDefinitionName = keyof ViteHubChannelDefinitionModules & string

export type ChannelRegistryDefinition<TName extends ChannelDefinitionName>
  = ViteHubChannelDefinitionModules[TName] extends { default?: infer TDefinition }
    ? NonNullable<TDefinition>
    : never

/** The send options of a discovered Channel's adapter. */
export type ChannelDefinitionSendOptions<TDefinition>
  = TDefinition extends { adapter: infer TAdapter } ? ChannelSendOptions<TAdapter> : never

/** The message of a discovered Channel's adapter. */
export type ChannelDefinitionMessage<TDefinition>
  = TDefinition extends { adapter: infer TAdapter } ? ChannelMessage<TAdapter> : never
