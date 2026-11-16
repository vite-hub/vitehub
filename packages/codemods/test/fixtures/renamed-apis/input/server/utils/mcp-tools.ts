/** The Console MCP tools and operations that the support Agent may call. */
export const allowedTools = ["kv_get", "kv_del", "blob_del"]
export const writeOperations = new Set(["kv.set", "kv.del", "blob.put", "blob.del"])
