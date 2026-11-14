import { agentDiagnostics } from "../agent-diagnostics.ts"
import { defineCapability } from "../capability-runtime.ts"
import { channelFormCard, channelFormsKey } from "../internal/channel-forms.ts"
import { messageChannelStateContextKey } from "../internal/channels.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { defineInternalTool, jsonObjectSchema } from "./internal.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ChannelForm, ChannelFormField } from "../internal/channel-forms.ts"
import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentChannelDeliveryEffectIntent, AgentToolSet } from "../types.ts"

/** A form from `defineForm()` of `@vite-hub/forms`, or a flat Standard Schema object, such as a Zod object. */
export type AgentForm = StandardSchemaV1 | { readonly "~form": true, readonly options: { readonly schema: StandardSchemaV1 } }

/** A form, or a form with the title that the button and the modal show. The title defaults to the name in words. */
export type AgentFormsOptions = Record<string, AgentForm | { form: AgentForm, title?: string }>

/** What the `ask_<name>` tool returns to the model. */
export type AgentFormAskResult
  = | { status: "asked", form: string, message: string }
    | { status: "unavailable", form: string, message: string, fields: ChannelFormField[] }

const toolName = /^[a-z][a-z0-9_]{0,40}$/

function invalid(problem: string): Error {
  return agentDiagnostics.AGENT_FORMS_INVALID({ problem })
}

function isForm(value: unknown): value is AgentForm {
  if (!isRuntimeRecord(value)) return false
  if (value["~form"] === true) return isRuntimeRecord(value.options) && isRuntimeRecord(value.options.schema) && isRuntimeRecord(value.options.schema["~standard"])
  return isRuntimeRecord(value["~standard"])
}

function words(name: string): string {
  const text = name.replaceAll("_", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

async function formsPackage() {
  return await import("@vite-hub/forms")
}

function channelForm(name: string, form: AgentForm, title: string): ChannelForm {
  return {
    name,
    title,
    async fields() {
      const { formFields } = await formsPackage()
      return formFields(form).map(({ name, label, type, required, description, options }) => ({
        name,
        label,
        type,
        required,
        ...(description ? { description } : {}),
        ...(options ? { options } : {}),
      }))
    },
    async modal(privateMetadata) {
      const { toChatModal } = await formsPackage()
      return toChatModal(form, { callbackId: "vitehub_form", title, submitLabel: "Send", privateMetadata })
    },
    async read(values) {
      const { chatModalErrors, readChatModal } = await formsPackage()
      const [error, data] = await readChatModal(form, values)
      return error ? { errors: chatModalErrors(error, form).errors } : { data }
    },
  }
}

/**
 * The cards that the tools of one chat Invocation queue. The run applies effects at its start and its finish only, so a
 * card that a tool asks for goes out with the finish effects, after the reply.
 */
const pendingCards = new WeakMap<object, AgentChannelDeliveryEffectIntent[]>()

function describeFields(fields: ChannelFormField[]): string {
  return fields.map(field => `${field.name} (${field.options ? field.options.join(" | ") : field.type}${field.required ? "" : ", optional"})`).join(", ")
}

async function formTools(context: AgentCapabilityContext, forms: Map<string, ChannelForm>): Promise<AgentToolSet> {
  const tools: AgentToolSet = {}
  for (const form of forms.values()) {
    const fields = await form.fields()
    tools[`ask_${form.name}`] = defineInternalTool<{ message: string }, AgentFormAskResult>({
      name: `ask_${form.name}`,
      title: `Asked for ${form.title}`,
      icon: "i-lucide-clipboard-list",
      description: `Ask the person to fill in the form "${form.title}". In a Slack or Teams conversation, a button opens the form, ViteHub checks the values, and the checked values come back as the person's next message. Fields: ${describeFields(fields)}.`,
      inputSchema: jsonObjectSchema({ message: { type: "string", description: "One short sentence on the card: why you need this form." } }, ["message"]),
      async execute({ message }, options) {
        const cards = pendingCards.get(context.context)
        if (!cards) {
          return {
            status: "unavailable",
            form: form.name,
            message: "This conversation cannot show a form. Ask the person for these fields in your reply.",
            fields,
          }
        }
        const { card, fallbackText } = channelFormCard(form, message, options?.toolCallId ?? crypto.randomUUID())
        cards.push({ kind: "reply", payload: { card, markdown: fallbackText } })
        return {
          status: "asked",
          form: form.name,
          message: "The card with the form button shows after your reply. The checked values come back as the person's next message. Do not ask for them again in this turn.",
        }
      },
    })
  }
  return tools
}

/**
 * Lets the Agent ask a person to fill in a form in a chat Channel. Each form gives one `ask_<name>` tool. In Slack and
 * Teams, the tool posts a card with a button, the button opens a modal drawn from the form, ViteHub checks the values
 * with the form schema and shows errors in the modal, and the checked values start the next turn as the person's
 * message. A chat without modals, such as Telegram, gets the list of fields. In web chat, a durable Workflow turn, or
 * a run outside a chat Channel, the tool returns the fields so the Agent asks for them in its reply.
 *
 * @example
 * capabilities: [forms({ expense })]
 */
export function forms(options: AgentFormsOptions): AgentCapabilityDefinition {
  if (!isRuntimeRecord(options) || !Object.keys(options).length) throw invalid("Pass at least one form, such as `forms({ expense })`.")
  const entries = new Map<string, ChannelForm>()
  for (const [name, value] of Object.entries(options)) {
    if (!toolName.test(name)) throw invalid(`The name ${JSON.stringify(name)} must be lowercase letters, digits, and underscores, such as \`expense\`, so that the tool name \`ask_<name>\` is valid.`)
    const form = isForm(value) ? value : isRuntimeRecord(value) && isForm(value.form) ? value.form : undefined
    if (!form) throw invalid(`The form ${JSON.stringify(name)} must be a defineForm() result or a Standard Schema object.`)
    const title = isRuntimeRecord(value) && "title" in value && value.title !== undefined ? value.title : words(name)
    if (typeof title !== "string" || !title.trim()) throw invalid(`The title of ${JSON.stringify(name)} must be a non-empty string.`)
    entries.set(name, channelForm(name, form, title.trim()))
  }
  const capability = defineCapability({
    id: "forms",
    metadata: { forms: [...entries.keys()] },
    prepare(context) {
      // Only a Chat SDK message turn that runs in the webhook route has a thread that can show the card. Web chat and
      // durable Workflow turns have none, so the tool returns the fields there.
      if (!context.context.get(messageChannelStateContextKey)) return
      const cards: AgentChannelDeliveryEffectIntent[] = []
      pendingCards.set(context.context, cards)
      context.delivery.finishEffect(Object.assign(() => cards.splice(0), { active: () => cards.length > 0, kind: "reply" as const }))
    },
    tools: context => formTools(context, entries),
  })
  return Object.assign(capability, { [channelFormsKey]: entries })
}
