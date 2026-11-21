import { Actions, Button, Card, CardText, Message } from "chat"

import { isRuntimeRecord } from "./runtime-type.ts"

import type { ActionEvent, CardElement, Chat, ModalElement, ModalResponse, ModalSubmitEvent, Thread } from "chat"
import type { MessageChannelStateBinding } from "./channels.ts"

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

const requestLifetimeMs = 24 * 60 * 60 * 1000
const answerPrefix = "vitehub-form:"

interface ChannelFormRequest {
  form: string
  id: string
  expiresAt: number
}

function readRequest(value: unknown): ChannelFormRequest | undefined {
  if (isRuntimeRecord(value) && typeof value.form === "string" && typeof value.id === "string" && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)) {
    return { form: value.form, id: value.id, expiresAt: value.expiresAt }
  }
}

function decodeRequest(value: string | undefined): ChannelFormRequest | undefined {
  if (!value) return
  try {
    return readRequest(JSON.parse(value))
  }
  catch {}
  return undefined
}

/** The card that the tool posts: why the Agent asks, and one button that opens the form. */
export function channelFormCard(form: Pick<ChannelForm, "name" | "title">, message: string): { card: CardElement, fallbackText: string } {
  const request: ChannelFormRequest = { form: form.name, id: crypto.randomUUID(), expiresAt: Date.now() + requestLifetimeMs }
  const card = Card({
    title: form.title,
    children: [
      CardText(message),
      Actions([Button({ id: channelFormAction, label: `Fill in ${form.title}`, style: "primary", value: JSON.stringify(request) })]),
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

function answerKey(binding: MessageChannelStateBinding, threadId: string, request: ChannelFormRequest): string {
  return `${binding.keyPrefix}channel-form:${JSON.stringify([threadId, request.id])}`
}

/** Claim a Slack form only after the answer passes Channel admission. */
export async function acceptChannelFormAnswer(binding: MessageChannelStateBinding, thread: Thread, message: Message): Promise<boolean> {
  if (!message.id.startsWith(answerPrefix)) return true
  const raw = message.raw
  if (!isRuntimeRecord(raw)) return false
  const request = readRequest(raw.request)
  if (!request || request.expiresAt <= Date.now()) return false
  if (!await binding.state.setIfNotExists(answerKey(binding, thread.id, request), true, requestLifetimeMs)) return false
  if (request.expiresAt <= Date.now()) return false
  if (typeof raw.cardId === "string" && typeof raw.title === "string") {
    await thread.adapter.editMessage(thread.id, raw.cardId, `${raw.title}: filled in by ${message.author.fullName || message.author.userName}.`).catch(() => undefined)
  }
  return true
}

/** The text of the person's next message: the checked values of the form, as JSON. */
function channelFormAnswerText(form: Pick<ChannelForm, "title">, data: unknown): string {
  return `I filled in ${form.title}:\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
}

/**
 * Opens the form when a person clicks its button, checks the modal values with the form schema, and starts the next
 * Agent turn with the checked values as the person's message.
 */
export function registerChannelForms(chat: Chat, forms: Map<string, ChannelForm>, binding: MessageChannelStateBinding, waitUntil?: (task: Promise<unknown>) => void): void {
  if (!forms.size) return
  chat.onAction(channelFormAction, async (event: ActionEvent) => {
    const request = decodeRequest(event.value)
    const form = request && forms.get(request.form)
    if (!request || !form || !event.thread || request.expiresAt <= Date.now() || await binding.state.get(answerKey(binding, event.thread.id, request))) {
      await event.thread?.post("This form is no longer available. Ask again.")
      return
    }
    await event.openModal(await form.modal(JSON.stringify(request)))
  })
  chat.onModalSubmit(channelFormAction, async (event: ModalSubmitEvent): Promise<ModalResponse | undefined> => {
    const request = decodeRequest(event.privateMetadata)
    const form = request && forms.get(request.form)
    const thread = event.relatedThread
    if (!request || !form || !thread || request.expiresAt <= Date.now()) {
      await thread?.post("This form is no longer available. Ask again.")
      return undefined
    }
    const answer = await form.read(event.values)
    if ("errors" in answer) return { action: "errors", errors: answer.errors }
    const message = new Message({
      attachments: [],
      author: event.user,
      formatted: { children: [], type: "root" },
      id: `${answerPrefix}${crypto.randomUUID()}`,
      isMention: true,
      metadata: { dateSent: new Date(), edited: false },
      raw: { request, cardId: event.relatedMessage?.id, title: form.title },
      text: channelFormAnswerText(form, answer.data),
      threadId: thread.id,
    })
    // Slack waits about three seconds for this answer, so the next turn runs after it.
    const turn = chat.processMessage(event.adapter, thread.id, message, waitUntil ? { waitUntil } : undefined)
    if (!waitUntil) void turn.catch(() => undefined)
    return undefined
  })
}
