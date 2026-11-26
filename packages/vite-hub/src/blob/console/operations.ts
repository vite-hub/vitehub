import * as v from "valibot"

import { loadConsoleMedia } from "../../console/runtime/server/blob.ts"

import { consoleOperationRequestBytes, defineConsoleOperation, optionalText, text } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

const consoleMediaReadActions: ReadonlySet<string> = new Set(["get", "info", "list", "usage"])

const mediaAction = defineConsoleOperation({
  mcp: false,
  description: "Run one media library action of a Console section.",
  input: v.strictObject({ action: text, body: v.optional(v.unknown()), section: text }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["media.action"],
  readOnlyWhen: ({ action }) => consoleMediaReadActions.has(action),
  name: "media.action",
  run: async ({ action, body, section }, context) => (await loadConsoleMedia()).runConsoleMediaAction(section, action, body, context.access),
  section: input => input.section,
})

const mediaUpload = defineConsoleOperation({
  mcp: false,
  description: "Upload one file, given as base64, to the media library of a Console section.",
  input: v.strictObject({
    contentType: optionalText,
    crop: optionalText,
    data: text,
    filename: v.pipe(text, v.minLength(1), v.maxLength(255)),
    folder: optionalText,
    pathname: optionalText,
    section: text,
  }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["media.upload"],
  name: "media.upload",
  run: async (input, context) => (await loadConsoleMedia()).uploadConsoleMedia(input, context.access),
  section: input => input.section,
})

/** The Console operations of the media library of a document editor section. The Console registers them only with Blob and a document editor. */
export const mediaConsoleOperations: readonly AnyOperation[] = [
  mediaAction,
  mediaUpload,
]
