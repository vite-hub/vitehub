import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { readViteHubConsoleActionFailure } from "@vite-hub/internal/console"
import type { ViteHubConsoleDocumentActions } from "@vite-hub/internal/console"
import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"

type Actions = Pick<ViteHubConsoleDocumentActions, "collections" | "get" | "list" | "save">

/** Reuses Console actions and their Content policy. The loader does not run until a tool call. */
export function contentMcpTools(load: () => Promise<Actions>): ViteHubMcpTool[] {
  const identity = { collection: { type: "string" }, id: { type: "string", description: "Document id. For a singleton, use its collection name." } }
  const definitions: Array<Pick<ViteHubMcpTool, "name" | "title" | "description" | "inputSchema"> & { action: keyof Actions }> = [
    {
      name: "content_list_collections",
      title: "List Content collections",
      description: "List the collections this Console user may read, with their field schemas.",
      action: "collections",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "content_list_documents",
      title: "List Content documents",
      description: "List documents this user may read, with draft digests and a nextCursor. Default limit 50.",
      action: "list",
      inputSchema: {
        type: "object",
        properties: {
          collection: identity.collection,
          cursor: { type: "string" },
          search: { type: "string" },
          state: { type: "string", enum: ["draft", "published", "changed", "deleted"] },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["collection"],
        additionalProperties: false,
      },
    },
    {
      name: "content_read_document",
      title: "Read a Content document",
      description: "Read a draft document and its digest with the Console user's Content access.",
      action: "get",
      inputSchema: { type: "object", properties: identity, required: ["collection", "id"], additionalProperties: false },
    },
    {
      name: "content_save_draft",
      title: "Save a Content draft",
      description: "Save a draft through the Console Content write policy. Use the current digest, or null for a new document. Honors edit leases. Does not publish.",
      action: "save",
      inputSchema: {
        type: "object",
        properties: {
          ...identity,
          data: { type: "object", description: "The document field values." },
          body: { type: "string", description: "Markdown body. Use an empty string for JSON or YAML." },
          ifDigest: { type: ["string", "null"], description: "The draft digest from a read, or null to create a new document." },
        },
        required: ["collection", "id", "data", "body", "ifDigest"],
        additionalProperties: false,
      },
    },
  ]

  return definitions.map(({ action, ...definition }): ViteHubMcpTool => ({
    ...definition,
    section: "content",
    annotations: action === "save" ? { readOnlyHint: false, destructiveHint: true } : { readOnlyHint: true },
    async call(input, context) {
      // Reject undeclared fields, including session ids and lease overrides.
      if (Object.keys(input).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) {
        return { text: "Use only the declared tool arguments.", isError: true }
      }
      try {
        const actions = await load()
        const user = { user: context.user }
        let value: unknown
        if (action === "collections") value = await actions.collections(user)
        else if (action === "list") {
          if (typeof input.collection !== "string") return { text: "collection must be a string.", isError: true }
          value = await actions.list({ ...input, collection: input.collection }, user)
        }
        else {
          const { collection, id, data, body, ifDigest } = input
          if (typeof collection !== "string" || typeof id !== "string") return { text: "collection and id must be strings.", isError: true }
          if (action === "get") value = await actions.get({ collection, id }, user)
          else {
            if (!data || typeof data !== "object" || Array.isArray(data) || typeof body !== "string" || (ifDigest !== null && typeof ifDigest !== "string")) {
              return { text: "Save requires data, body, and ifDigest.", isError: true }
            }
            value = await actions.save({ collection, id, data: Object.fromEntries(Object.entries(data)), body, ifDigest }, user)
          }
        }
        const structured = { value: value ?? null }
        return { text: JSON.stringify(structured), structured }
      }
      catch (error) {
        const failure = readViteHubConsoleActionFailure(error)
        if (!failure) throw error
        return { text: failure.message, structured: { code: failure.code, ...(failure.details ? { details: failure.details } : {}) }, isError: true }
      }
    },
  }))
}


/** Registers Content tools at Console startup without loading the application module. */
export function registerContentMcpTools(load: () => Promise<Actions>): void {
  registerViteHubMcpTools("content", contentMcpTools(load))
}
