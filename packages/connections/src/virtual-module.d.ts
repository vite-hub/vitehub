declare module "#vitehub/connections/registry" {
  const registry: import("./types.js").ConnectionDefinitionRegistry
  export const activityRetention: import("./types.js").ConnectionActivityRetention | false | undefined
  export const database: import("./types.js").ConnectionsDatabaseLoader | undefined
  /** Markdown from the `<name>.md` next to each definition file, by definition name. */
  export const docs: Readonly<Record<string, () => Promise<string>>> | undefined
  export default registry
}
