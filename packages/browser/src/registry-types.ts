declare global {
  interface ViteHubBrowserDefinitionModules {}
}

export type BrowserDefinitionName = keyof ViteHubBrowserDefinitionModules

export type BrowserRegistryDefinition<TName extends keyof ViteHubBrowserDefinitionModules>
  = ViteHubBrowserDefinitionModules[TName] extends { default?: infer TDefinition } ? NonNullable<TDefinition> : never

type BrowserDefinitionInput<TDefinition>
  = TDefinition extends { run: (input: infer TInput, ...args: any[]) => any } ? TInput : unknown

export type BrowserDefinitionInputArgs<TDefinition>
  = unknown extends BrowserDefinitionInput<TDefinition>
    ? [input?: BrowserDefinitionInput<TDefinition>]
    : undefined extends BrowserDefinitionInput<TDefinition>
      ? [input?: BrowserDefinitionInput<TDefinition>]
      : [input: BrowserDefinitionInput<TDefinition>]

export type BrowserDefinitionResult<TDefinition>
  = TDefinition extends { run: (...args: any[]) => infer TResult } ? Awaited<TResult> : unknown
