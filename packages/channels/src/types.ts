export interface ChannelConnectorResult {
  id?: string
  raw?: unknown
}

export interface ChannelSendResult extends ChannelConnectorResult {
  channel: string
  connector: string
  deliveryId: string
}

export interface ChannelConnector<TOptions = Record<string, unknown>, TResult extends ChannelConnectorResult = ChannelConnectorResult> {
  send: (text: string, options: TOptions) => Promise<TResult> | TResult
}

export type ChannelConnectorMap = Record<string, ChannelConnector<any, any>>

export interface ChannelDefinition<
  TConnectors extends ChannelConnectorMap = ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
> {
  connectors: TConnectors
  defaultConnector?: TDefault
}

export interface ChannelDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ChannelDefinition } | ChannelDefinition>
}

export interface DiscoveredChannelDefinition {
  handler: string
  name: string
  source: "server-channels" | "vite-suffix"
}

type ConnectorOptions<TConnector> = TConnector extends ChannelConnector<infer TOptions, any> ? TOptions : never

type ExplicitChannelSendOptions<TConnectors extends ChannelConnectorMap> = {
  [TName in keyof TConnectors & string]: {
    connector: TName
  } & ConnectorOptions<TConnectors[TName]>
}[keyof TConnectors & string]

type DefaultChannelSendOptions<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string,
> = {
  connector?: TDefault
} & ConnectorOptions<TConnectors[TDefault]>

export type ChannelSendOptions<
  TConnectors extends ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
> = ExplicitChannelSendOptions<TConnectors>
  | ([TDefault] extends [never] ? never : DefaultChannelSendOptions<TConnectors, TDefault>)

export interface ChannelClient<
  TConnectors extends ChannelConnectorMap = ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
> {
  readonly name: string
  send: (text: string, options: ChannelSendOptions<TConnectors, TDefault>) => Promise<ChannelSendResult>
}
