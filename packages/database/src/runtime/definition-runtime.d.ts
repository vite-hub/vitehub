declare module "#vitehub/database/definition-runtime" {
  export function createDefinitionRuntime<TSchema extends Record<string, unknown>, TRelations extends import("drizzle-orm").AnyRelations>(
    definition: import("../types.ts").DatabaseDefinition<TSchema, TRelations>,
  ): import("../types.ts").RuntimeDrizzleDatabase<TSchema, TRelations>
}
