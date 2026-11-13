import { fieldErrors } from "./client.ts"
import { checkForm, collectFields, decodeFieldValue, formFields, isLongText, unsupportedField } from "./fields.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { FormSubmitError } from "./client.ts"
import type { FormField, FormSource } from "./fields.ts"

/** One property of an MCP elicitation form: the primitive schemas of MCP `2025-11-25`. */
export type ElicitationProperty
  = | { type: "string", title: string, description?: string, minLength?: number, maxLength?: number, format?: "email" | "uri" | "date" | "date-time" }
    | { type: "string", title: string, description?: string, enum: string[] }
    | { type: "number" | "integer", title: string, description?: string, minimum?: number, maximum?: number }
    | { type: "boolean", title: string, description?: string }

/** The params of an MCP `elicitation/create` request in form mode. */
export interface FormElicitation {
  mode: "form"
  message: string
  requestedSchema: {
    type: "object"
    properties: Record<string, ElicitationProperty>
    required?: string[]
  }
}

/** The answer of an MCP client to `elicitation/create`. */
export type ElicitationResult
  = | { action: "accept", content?: Record<string, unknown> }
    | { action: "decline" | "cancel", content?: undefined }

const elicitationTakes = "a flat object of text, numbers, true or false, and choices of text"

function elicitationProperty(field: FormField): ElicitationProperty {
  const base = { title: field.label, ...(field.description ? { description: field.description } : {}) }
  if (field.options) {
    const options = field.options
    // MCP enums hold text only. A choice of numbers would come back as text that the schema refuses.
    if (!options.every((option): option is string => typeof option === "string")) throw unsupportedField({ field: field.name, found: "a choice of numbers" }, "An MCP elicitation", elicitationTakes)
    return { type: "string", ...base, enum: [...options] }
  }
  if (field.type === "boolean") return { type: "boolean", ...base }
  if (field.type === "number" || field.type === "integer") {
    return { type: field.type, ...base, ...(field.minimum !== undefined ? { minimum: field.minimum } : {}), ...(field.maximum !== undefined ? { maximum: field.maximum } : {}) }
  }
  return {
    type: "string",
    ...base,
    ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.format ? { format: field.format } : {}),
  }
}

/**
 * The params of an MCP `elicitation/create` request that asks the person for the fields of a form. MCP takes a flat
 * object of primitive properties, so a nested object, a list, or a choice of numbers throws `FORMS_C0002`.
 *
 * ```ts
 * const answer = await server.elicitInput(toElicitation(contact, { message: "How can we reach you?" }))
 * const [error, result] = await readElicitation(contact, answer)
 * ```
 */
export function toElicitation(source: FormSource, options: { message: string }): FormElicitation {
  const { fields, problems } = collectFields(source)
  const [problem] = problems
  if (problem) throw unsupportedField(problem, "An MCP elicitation", elicitationTakes)
  const required = fields.filter(field => field.required).map(field => field.name)
  return {
    mode: "form",
    message: options.message,
    requestedSchema: {
      type: "object",
      properties: Object.fromEntries(fields.map(field => [field.name, elicitationProperty(field)])),
      ...(required.length ? { required } : {}),
    },
  }
}

/**
 * Checks the answer to `toElicitation()` with the form schema. Returns `[undefined, { action: "accept", data }]`,
 * `[undefined, { action: "decline" }]` or `"cancel"` when the person did not answer, or `[error]` with the issue of
 * each field, the same issues as the form route.
 */
export async function readElicitation<TSchema extends StandardSchemaV1>(source: FormSource<TSchema>, result: ElicitationResult): Promise<[FormSubmitError, undefined] | [undefined, { action: "accept", data: StandardSchemaV1.InferOutput<TSchema> } | { action: "decline" | "cancel" }]> {
  if (result.action !== "accept") return [undefined, { action: result.action }]
  const [error, data] = await checkForm(source, result.content ?? {})
  return error ? [error, undefined] : [undefined, { action: "accept", data }]
}

interface ChatModalOption {
  label: string
  value: string
}

/** One input of a chat modal, in the shape of a Chat SDK modal child. */
export type FormChatModalChild
  = | { type: "text_input", id: string, label: string, optional: boolean, multiline?: boolean, maxLength?: number }
    | { type: "date_input", id: string, label: string, optional: boolean }
    | { type: "number_input", id: string, label: string, optional: boolean, decimal: boolean, min?: number, max?: number }
    | { type: "select", id: string, label: string, optional: boolean, options: ChatModalOption[] }
    | { type: "radio_select", id: string, label: string, optional: boolean, options: ChatModalOption[] }

/** A modal in the shape of a Chat SDK `ModalElement`, which its Slack and Teams adapters draw. */
export interface FormChatModal {
  type: "modal"
  callbackId: string
  title: string
  submitLabel?: string
  closeLabel?: string
  privateMetadata?: string
  children: FormChatModalChild[]
}

export interface ChatModalOptions {
  /** The id that `bot.onModalSubmit()` matches. */
  callbackId: string
  /** At most 24 characters in Slack. */
  title: string
  submitLabel?: string
  closeLabel?: string
  /** Text that comes back with the submission, such as JSON context. */
  privateMetadata?: string
}

function chatInput(field: FormField): FormChatModalChild {
  const base = { id: field.name, label: field.label, optional: !field.required }
  if (field.type === "boolean") return { type: "radio_select", ...base, options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] }
  if (field.options) return { type: "select", ...base, options: field.options.map(option => ({ label: String(option), value: String(option) })) }
  if (field.type === "number" || field.type === "integer") {
    return { type: "number_input", ...base, decimal: field.type === "number", ...(field.minimum !== undefined ? { min: field.minimum } : {}), ...(field.maximum !== undefined ? { max: field.maximum } : {}) }
  }
  if (field.format === "date") return { type: "date_input", ...base }
  return { type: "text_input", ...base, ...(isLongText(field) ? { multiline: true } : {}), ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}) }
}

/**
 * A Chat SDK modal with one input for each field of a form: a text, date, or number input, a select for a choice, and
 * Yes or No for true or false. The input id is the field name, so the Slack `block_id` is the field name too. Open it
 * with `event.openModal()` of the Chat SDK, which draws a Slack modal or a Teams dialog. Throws `FORMS_C0002` for a
 * field that a modal cannot draw.
 */
export function toChatModal(source: FormSource, options: ChatModalOptions): FormChatModal {
  return {
    type: "modal",
    callbackId: options.callbackId,
    title: options.title,
    ...(options.submitLabel ? { submitLabel: options.submitLabel } : {}),
    ...(options.closeLabel ? { closeLabel: options.closeLabel } : {}),
    ...(options.privateMetadata ? { privateMetadata: options.privateMetadata } : {}),
    children: formFields(source).map(chatInput),
  }
}

/**
 * Checks the `values` of a Chat SDK modal submission, which are text by input id, with the form schema. Returns
 * `[undefined, data]`, or `[error]` with the issue of each field, the same issues as the form route. Answer an error
 * with `chatModalErrors(error, form)`.
 *
 * ```ts
 * bot.onModalSubmit("contact", async (event) => {
 *   const [error, data] = await readChatModal(contact, event.values)
 *   if (error) return chatModalErrors(error, contact)
 *   await save(data)
 * })
 * ```
 */
export async function readChatModal<TSchema extends StandardSchemaV1>(source: FormSource<TSchema>, values: Record<string, string | undefined>): Promise<[FormSubmitError, undefined] | [undefined, StandardSchemaV1.InferOutput<TSchema>]> {
  const data: Record<string, unknown> = {}
  for (const field of formFields(source)) {
    // Text keeps an empty answer, as a web form sends it. An empty number or choice is a field that the person left out.
    const value = decodeFieldValue(field, values[field.name])
    if (value !== undefined) data[field.name] = value
  }
  return checkForm(source, data)
}

/**
 * The Chat SDK answer that shows the error of each field under its input: `{ action: "errors", errors }`. The Slack
 * adapter sends it as `response_action: "errors"`, keyed by `block_id`, which is the field name. A modal shows errors
 * only under inputs, so pass the form too: an error of the whole form, such as a check across two fields, then shows
 * under the first input.
 */
export function chatModalErrors(error: FormSubmitError, source?: FormSource): { action: "errors", errors: Record<string, string> } {
  const errors = fieldErrors(error)
  const whole = error.issues.filter(issue => issue.path.length === 0).map(issue => issue.message)
  const first = source && whole.length ? collectFields(source).fields[0]?.name : undefined
  if (first) errors[first] = [errors[first], ...whole].filter(Boolean).join(" ")
  return { action: "errors", errors }
}
