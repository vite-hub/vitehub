declare module "#vitehub/queue/registry" {
  const registry: import("./index.js").QueueDefinitionRegistry
  export default registry
}

declare module "#vitehub/queue/node-client" {
  export const createPostgresQueueRuntimeClient: typeof import("./internal/runtime/postgres-client.js").createPostgresQueueRuntimeClient
}
