import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { FormSubmission } from "./types.ts"

// The inbox lives in the Nitro runtime. The operations load it when they run, so the CLI can list them without it.
async function inbox() {
  const installed = (await import("./runtime.ts")).installedForms()
  if (!installed) throw new Error("[vitehub] The app has no forms. Add server/forms/<name>.ts with defineForm().")
  return installed.inbox
}

async function unwrap<T>(result: Promise<[Error, undefined] | [undefined, T]>): Promise<T> {
  const [error, value] = await result
  if (error) throw error
  return value as T
}

function defineFormsOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // Access to the Forms section of the Console decides. The operations never read the signed-in user.
  return defineOperation({ ...definition, cli: { namespace: "forms", ...definition.cli }, section: "forms", user: false })
}

const status = v.picklist(["open", "done", "spam"])

const list = defineFormsOperation<{ form?: string, status?: "open" | "done" | "spam", limit?: number, before?: { createdAt: number, id: string } }, FormSubmission[]>({
  cli: { default: true },
  description: "List form submissions, newest first.",
  input: v.object({
    form: v.optional(v.pipe(v.string(), v.description("Only this form, such as contact."))),
    status: v.optional(status),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
    before: v.optional(v.object({ createdAt: v.number(), id: v.string() })),
  }),
  kind: "read",
  name: "forms.list",
  run: async input => await unwrap((await inbox()).list(input)),
})

const get = defineFormsOperation<{ id: string }, FormSubmission>({
  cli: { positional: ["id"] },
  description: "Show one form submission.",
  input: v.object({ id: v.pipe(v.string(), v.minLength(1)) }),
  kind: "read",
  name: "forms.get",
  run: async input => await unwrap((await inbox()).get(input.id)),
})

const mark = defineFormsOperation<{ id: string, status: "open" | "done" | "spam" }, FormSubmission>({
  cli: { positional: ["id", "status"] },
  description: "Mark a form submission open, done, or spam.",
  input: v.object({ id: v.pipe(v.string(), v.minLength(1)), status }),
  kind: "write",
  name: "forms.mark",
  run: async input => await unwrap((await inbox()).setStatus(input.id, input.status)),
})

/** The `forms.*` operations: list, get, and mark. The Console, `vitehub forms`, and MCP run them. */
export const formsOperations: readonly AnyOperation[] = [list, get, mark]
