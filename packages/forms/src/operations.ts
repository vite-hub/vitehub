import { defineOperation, table } from "@vite-hub/internal/operations"
import stripAnsi from "strip-ansi"
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

/** The first text value of a submission on one line, such as its message. */
function preview(data: unknown): string {
  const values = Object.values(Object(data) as Record<string, unknown>)
  const text = values.find((value): value is string => typeof value === "string" && value.includes(" ")) ?? values.find(value => typeof value === "string") ?? ""
  const line = stripAnsi(text).replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim()
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "-"
}

function formatList(rows: FormSubmission[]): string {
  if (!rows.length) return "No form submissions.\n"
  return `${table([
    ["ID", "FORM", "STATUS", "SENT AT", "TEXT"],
    ...rows.map(row => [row.id, row.form, row.status, new Date(row.createdAt).toISOString(), preview(row.data)]),
  ])}\n`
}

function formatOne(row: FormSubmission): string {
  return [
    `Submission: ${row.id}`,
    `Form: ${row.form}`,
    `Status: ${row.status}`,
    `Sent at: ${new Date(row.createdAt).toISOString()}`,
    ...(row.page ? [`Page: ${row.page}`] : []),
    ...(row.user ? [`User: ${row.user.email ?? row.user.name ?? row.user.id}`] : []),
    ...(row.anchor ? [`Anchor: ${row.anchor.selector} "${row.anchor.exact}"`] : []),
    "Data:",
    JSON.stringify(row.data, null, 2),
    "",
  ].join("\n")
}

const list = defineFormsOperation<{ form?: string, status?: "open" | "done" | "spam", limit?: number, before?: { createdAt: number, id: string } }, FormSubmission[]>({
  cli: { default: true, format: formatList },
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
  cli: { format: formatOne, positional: ["id"] },
  description: "Show one form submission.",
  input: v.object({ id: v.pipe(v.string(), v.minLength(1)) }),
  kind: "read",
  name: "forms.get",
  run: async input => await unwrap((await inbox()).get(input.id)),
})

const mark = defineFormsOperation<{ id: string, status: "open" | "done" | "spam" }, FormSubmission>({
  cli: { format: (row: FormSubmission) => `Marked ${row.id} ${row.status}.\n`, positional: ["id", "status"] },
  description: "Mark a form submission open, done, or spam.",
  input: v.object({ id: v.pipe(v.string(), v.minLength(1)), status }),
  kind: "write",
  name: "forms.mark",
  run: async input => await unwrap((await inbox()).setStatus(input.id, input.status)),
})

/** The `forms.*` operations: list, get, and mark. The Console, `vitehub forms`, and MCP run them. */
export const formsOperations: readonly AnyOperation[] = [list, get, mark]

export { createStandaloneOperationHandler } from "@vite-hub/internal/operations-dev"
