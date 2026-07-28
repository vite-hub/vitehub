declare module "#vitehub/browser/registry" {
  export interface BrowserDefinitionModules {}

  const registry: import("./types.ts").BrowserDefinitionRegistry
  export default registry
}

declare module "#vitehub/browser/runtime" {
  const config: import("./types.ts").BrowserRuntimeConfig
  export default config
}
