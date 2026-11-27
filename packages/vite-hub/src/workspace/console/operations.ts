import * as v from "valibot"

import { defineConsoleOperation, legacyEvent, optionalText, text } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

const workspacesFiles = defineConsoleOperation({
  cli: { namespace: "workspaces", positional: ["name"] },
  description: "Read the files, refs, and revisions of one Workspace, and its changes since main.",
  input: v.strictObject({ cursor: optionalText, name: v.pipe(text, v.minLength(1)), path: optionalText, ref: optionalText, revision: optionalText }),
  kind: "read",
  name: "workspaces.files",
  run: async (input, context) => (await import("./workspace-files.get.ts")).default(legacyEvent("workspace-files", "GET", { query: input }, context)),
  section: "workspaces",
})

/** The Console operation of the Workspaces section. The Console registers it only when the app has Workspaces. */
export const workspaceConsoleOperations: readonly AnyOperation[] = [
  workspacesFiles,
]
