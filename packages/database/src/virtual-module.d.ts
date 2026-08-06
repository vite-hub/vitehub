declare module "#vitehub/database/schema" {
  export interface DatabaseSchema {
    [name: string]: unknown
  }

  const schema: DatabaseSchema
  export default schema
}

declare module "#vitehub/database/databases" {
  export interface DatabaseRegistry {
    default: {
      config: import("./types.ts").ResolvedDrizzleDatabaseConfig
      schema: import("#vitehub/database/schema").DatabaseSchema
    }
  }

  const databases: DatabaseRegistry
  export { databases }
  export default databases
}

declare module "#vitehub/database/definition-defaults" {
  const defaults: {
    cloudflare?: import("./types.ts").CloudflareD1BindingConfig
    connection?: import("./types.ts").DatabaseConnectionConfig
  }
  export default defaults
}
