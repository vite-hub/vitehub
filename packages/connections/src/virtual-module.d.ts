declare module "#vitehub/connections/registry" {
  const registry: import("./types.js").ConnectionDefinitionRegistry
  export const activityRetention: import("./types.js").ConnectionActivityRetention | false | undefined
  export const database: import("./types.js").ConnectionsDatabaseLoader | undefined
  export default registry
}
