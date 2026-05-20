declare module "#vitehub/db/schema" {
  const schema: Record<string, unknown>
  export default schema
}

declare module "#vitehub/db/databases" {
  const databases: Record<string, {
    config: import("./types.ts").ResolvedDrizzleDatabaseConfig
    schema: Record<string, unknown>
  }>
  export default databases
}
