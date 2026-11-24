import * as v from "valibot"

import { consoleDocumentActionNames } from "../../console/runtime/server/limits.ts"

import { actionResult, consoleOperationRequestBytes, defineConsoleOperation, legacyEvent, text } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

const consoleDocumentReadActions: ReadonlySet<string> = new Set(["get", "list", "overview", "raw", "references", "resolve", "revisions", "search", "sessions"])

const documentsAction = defineConsoleOperation({
  mcp: false,
  description: "Run one document editor action of a Console section.",
  input: v.strictObject({ action: v.picklist(consoleDocumentActionNames), body: v.optional(v.unknown()), section: text }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["documents.action"],
  readOnlyWhen: ({ action, body }) => action === "session"
    ? typeof body === "object" && body !== null && "action" in body && (body.action === "report" || body.action === "release")
    : consoleDocumentReadActions.has(action),
  name: "documents.action",
  run: async ({ action, body, section }, context) => {
    const documents = await import("../../console/runtime/server/documents.ts")
    if (body === undefined) {
      const actions = await documents.loadConsoleDocumentActions(section)
      const user = await documents.consoleDocumentActionContext(context.access)
      return await documents.runConsoleDocumentAction(() => actions[action](body, user)) ?? null
    }
    const result = actionResult(await documents.default(legacyEvent("documents", "POST", { body, query: { action, section } }, context))) as { value: unknown }
    return result.value
  },
  section: input => input.section,
})

const documentsPreview = defineConsoleOperation({
  mcp: false,
  description: "Return a one-time link that opens the page of a document with its draft, on the app origin.",
  input: v.strictObject({ collection: v.pipe(text, v.minLength(1)), id: v.pipe(text, v.minLength(1)), section: text }),
  kind: "read",
  name: "documents.preview",
  run: async ({ collection, id, section }, context) => (await import("../../console/runtime/server/documents.ts")).issueConsoleDocumentPreview(context, { collection, id, section }),
  section: input => input.section,
})

/** The Console operations of the document editor sections. The Console registers them only when a document editor section exists. */
export const documentConsoleOperations: readonly AnyOperation[] = [
  documentsAction,
  documentsPreview,
]
