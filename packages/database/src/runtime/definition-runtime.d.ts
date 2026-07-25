declare module "#vitehub/database/definition-runtime" {
  export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
    definition: import("../types.ts").DatabaseDefinition<TSchema>,
  ): import("../types.ts").RuntimeDrizzleDatabase<TSchema>
}
