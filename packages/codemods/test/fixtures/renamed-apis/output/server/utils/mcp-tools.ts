/** The Console MCP tools and operations that the support Agent may call. */
export const allowedTools = ["kv_get", "kv_delete", "blob_delete"]
export const writeOperations = new Set(["kv.set", "kv.delete", "blob.put", "blob.delete"])
