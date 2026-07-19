import type { AgentAdapter, AgentDefinition } from "../src/index.ts"

export function adapterDefinition<T extends Pick<AgentAdapter, "generate"> & Partial<Pick<AgentAdapter, "name" | "stream">>>(adapter: T): AgentDefinition {
  return {
    resolve: async () => ({ ...adapter, name: adapter.name || "test" }),
  }
}
