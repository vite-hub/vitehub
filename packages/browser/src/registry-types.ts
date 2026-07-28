declare global {
  interface ViteHubBrowserDefinitionModules {}
}

export type BrowserDefinitionName = keyof ViteHubBrowserDefinitionModules

export type BrowserRegistryDefinition<TName extends keyof ViteHubBrowserDefinitionModules>
  = ViteHubBrowserDefinitionModules[TName] extends { default?: infer TDefinition } ? NonNullable<TDefinition> : never

export type BrowserDefinitionInput<TDefinition>
  = TDefinition extends { run: (input: infer TInput, ...args: any[]) => any } ? TInput : unknown

export type BrowserDefinitionResult<TDefinition>
  = TDefinition extends { run: (...args: any[]) => infer TResult } ? Awaited<TResult> : unknown
