declare module "#vitehub/database/definition-runtime" {
  export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
    definition: import("../types.ts").DatabaseDefinition<TSchema>,
  ): import("../types.ts").RuntimeDrizzleDatabase<TSchema>
  export function createConfiguredDatabase<TSchema extends Record<string, unknown>>(
    config: import("../types.ts").RuntimeDrizzleDatabaseConfig,
    schema: TSchema,
  ): import("../types.ts").RuntimeDrizzleDatabase<TSchema>
}
