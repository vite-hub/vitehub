declare module "#vitehub/database/schema" {
  export interface DatabaseSchema {
    [name: string]: unknown
  }

  const schema: DatabaseSchema
  export default schema
}

declare module "#vitehub/database/databases" {
  export interface DatabaseRegistry {}

  const databases: DatabaseRegistry
  export { databases }
  export default databases
}

declare module "#vitehub/database/definition-defaults" {
  const defaults: {
    cloudflare?: import("./index.js").CloudflareD1BindingConfig
    connection?: import("./index.js").DatabaseConnectionConfig
  }
  export default defaults
}
