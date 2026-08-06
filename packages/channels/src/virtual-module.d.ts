declare module "#vitehub/channels/registry" {
  const registry: import("./types.js").ChannelDefinitionRegistry
  export default registry
}

declare module "#vitehub/channels/runtime" {
  export function resolveChannelRuntimeEnv(): import("./types.js").ChannelRuntimeEnv
}
