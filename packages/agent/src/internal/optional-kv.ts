/** The Agent Vite plugin keeps this external when the host does not configure KV. */
export async function importOptionalKV(): Promise<typeof import("@vite-hub/kv")> {
  return await import("@vite-hub/kv")
}
