import { Actions, Button, Card, CardText, Message } from "chat"

import { isRuntimeRecord } from "./runtime-type.ts"

import type { ActionEvent, CardElement, Chat, ModalElement, ModalResponse, ModalSubmitEvent } from "chat"

/** The id of the button that opens a form, and the callback id of its modal. */
export const channelFormAction = "vitehub_form"

/** Keys the forms that a `forms()` Capability gives, so the channel route finds them without a registry. */
export const channelFormsKey: unique symbol = Symbol.for("vitehub.agent.channelForms") as never

/** One field of a form, as the Agent sees it when no modal can show the form. */
export interface ChannelFormField {
  name: string
  label: string
  type: "string" | "number" | "integer" | "boolean"
  required: boolean
  description?: string
  options?: readonly (string | number)[]
}

/** A form of `forms()`, with the Forms functions that draw and check it. */
export interface ChannelForm {
  name: string
  title: string
  fields: () => Promise<ChannelFormField[]>
  modal: (privateMetadata: string) => Promise<ModalElement>
  /** Checks the modal values. Returns the field errors, or the data. */
  read: (values: Record<string, string>) => Promise<{ errors: Record<string, string> } | { data: unknown }>
}

/** What the button and the modal carry, so a click on any host process finds the form and the tool call. */
interface ChannelFormRequest {
  form: string
  call: string
}

function encodeRequest(request: ChannelFormRequest): string {
  return JSON.stringify(request)
}

function decodeRequest(value: string | undefined): ChannelFormRequest | undefined {
  if (!value) return
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRuntimeRecord(parsed) && typeof parsed.form === "string" && typeof parsed.call === "string") return { form: parsed.form, call: parsed.call }
  }
  catch {}
  return undefined
}

/** The card that the tool posts: why the Agent asks, and one button that opens the form. */
export function channelFormCard(form: Pick<ChannelForm, "name" | "title">, message: string, call: string): { card: CardElement, fallbackText: string } {
  const card = Card({
    title: form.title,
    children: [
      CardText(message),
      Actions([Button({ id: channelFormAction, label: `Fill in ${form.title}`, style: "primary", value: encodeRequest({ form: form.name, call }) })]),
    ],
  })
  return { card, fallbackText: `${message}\n\nUse the button to fill in ${form.title}.` }
}

/** The forms of the `forms()` Capabilities of an Agent. */
export function channelFormsOf(capabilities: readonly object[]): Map<string, ChannelForm> {
  const found = new Map<string, ChannelForm>()
  for (const capability of capabilities) {
    const forms: unknown = Reflect.get(capability, channelFormsKey)
    if (forms instanceof Map) for (const [name, form] of forms) found.set(name, form)
  }
  return found
}

function fieldList(fields: ChannelFormField[]): string {
  return fields.map(field => `- ${field.label}${field.options ? ` (${field.options.join(", ")})` : ""}${field.required ? "" : " (optional)"}`).join("\n")
}

/** The text of the person's next message: the checked values of the form, as JSON. */
function channelFormAnswerText(form: Pick<ChannelForm, "title">, data: unknown): string {
  return `I filled in ${form.title}:\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
}

/**
 * Opens the form when a person clicks its button, checks the modal values with the form schema, and starts the next
 * Agent turn with the checked values as the person's message. A chat that cannot open a modal, such as Telegram, gets
 * the list of fields to answer in a message instead.
 */
export function registerChannelForms(chat: Chat, forms: Map<string, ChannelForm>, waitUntil?: (task: Promise<unknown>) => void): void {
  if (!forms.size) return
  chat.onAction(channelFormAction, async (event: ActionEvent) => {
    const request = decodeRequest(event.value)
    const form = request && forms.get(request.form)
    if (!request || !form) {
      await event.thread?.post("This form is no longer available. Ask again.")
      return
    }
    const opened = await event.openModal(await form.modal(encodeRequest(request)))
    if (!opened) await event.thread?.post(`This chat cannot open forms. Reply with these values for ${form.title}:\n\n${fieldList(await form.fields())}`)
  })
  chat.onModalSubmit(channelFormAction, async (event: ModalSubmitEvent): Promise<ModalResponse | undefined> => {
    const request = decodeRequest(event.privateMetadata)
    const form = request && forms.get(request.form)
    const thread = event.relatedThread
    if (!request || !form || !thread) {
      await thread?.post("This form is no longer available. Ask again.")
      return undefined
    }
    const answer = await form.read(event.values)
    if ("errors" in answer) return { action: "errors", errors: answer.errors }
    await event.relatedMessage?.edit(`${form.title}: filled in by ${event.user.fullName || event.user.userName}.`).catch(() => undefined)
    const message = new Message({
      attachments: [],
      author: event.user,
      formatted: { children: [], type: "root" },
      // One answer per tool call: Chat SDK drops a second submission of the same form as a duplicate message.
      id: `vitehub-form:${request.call}`,
      isMention: true,
      metadata: { dateSent: new Date(), edited: false },
      raw: { form: request.form, toolCallId: request.call },
      text: channelFormAnswerText(form, answer.data),
      threadId: thread.id,
    })
    // Slack waits about three seconds for this answer, so the next turn runs after it.
    const turn = chat.processMessage(event.adapter, thread.id, message, waitUntil ? { waitUntil } : undefined)
    if (!waitUntil) void turn.catch(() => undefined)
    return undefined
  })
}
