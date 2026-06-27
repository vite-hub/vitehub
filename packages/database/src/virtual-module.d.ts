declare module "#vitehub/database/schema" {
  const schema: Record<string, import("drizzle-orm/sqlite-core").SQLiteTable>
  export default schema
}

declare module "#vitehub/database/databases" {
  const databases: Record<string, {
    config: import("./types.ts").ResolvedDrizzleDatabaseConfig
    schema: Record<string, import("drizzle-orm/sqlite-core").SQLiteTable>
  }>
  export default databases
}
