declare global {
  interface ViteHubConnectionDefinitionModules {}
}

/** Names of discovered Connections. Any string when no Connection is discovered yet. */
export type ConnectionName = [keyof ViteHubConnectionDefinitionModules & string] extends [never]
  ? string
  : keyof ViteHubConnectionDefinitionModules & string
