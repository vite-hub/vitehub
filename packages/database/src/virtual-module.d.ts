declare module "#vitehub/database/schema" {
  const schema: Record<string, unknown>
  export default schema
}

declare module "#vitehub/database/databases" {
  const databases: Record<string, {
    config: import("./types.ts").ResolvedDrizzleDatabaseConfig
    schema: Record<string, unknown>
  }>
  export default databases
}

declare module "#vitehub/database/definition-defaults" {
  const defaults: {
    connection?: import("./types.ts").DatabaseConnectionConfig
  }
  export default defaults
}
