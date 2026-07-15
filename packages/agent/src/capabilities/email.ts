import { defineCapability } from "../capability-runtime.ts"
import { defineInternalTool, requirePrimitive } from "./internal.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
  AgentToolSchema,
  MaybePromise,
} from "../types.ts"

export type EmailCapabilityToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface EmailCapabilityOptions {
  from: string
  recipients?: readonly string[]
  policy?: EmailCapabilityToolPolicy
}

interface EmailSendInput {
  subject: string
  text: string
  to: string | readonly string[]
}

interface EmailRuntimeClient {
  send: (message: EmailSendInput & { from: string }) => MaybePromise<unknown>
}

const emailSendInputSchema: AgentToolSchema<EmailSendInput> = {
  additionalProperties: false,
  properties: {
    subject: { minLength: 1, type: "string" },
    text: { minLength: 1, type: "string" },
    to: {
      anyOf: [
        { minLength: 1, type: "string" },
        { items: { minLength: 1, type: "string" }, minItems: 1, type: "array" },
      ],
    },
  },
  required: ["to", "subject", "text"],
  type: "object",
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`[vitehub] ${label} must be a non-empty string.`)
  }
  return value
}

function validateRecipients(value: unknown): string | readonly string[] {
  if (typeof value === "string") return nonEmptyString(value, "email_send to")
  if (!Array.isArray(value)) {
    throw new TypeError("[vitehub] email_send to must be a non-empty email address or array of email addresses.")
  }
  const recipients = Array.from(value)
  if (recipients.length === 0 || recipients.some(address => typeof address !== "string" || !address.trim())) {
    throw new TypeError("[vitehub] email_send to must be a non-empty email address or array of email addresses.")
  }
  return recipients as string[]
}

function recipientKey(address: string): string {
  return address.trim().toLowerCase()
}

function normalizeRecipients(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new TypeError("[vitehub] email({ recipients }) must be an array of non-empty email addresses.")
  }
  const recipients = Array.from(value)
  if (recipients.some(address => typeof address !== "string" || !address.trim())) {
    throw new TypeError("[vitehub] email({ recipients }) must be an array of non-empty email addresses.")
  }
  return recipients as string[]
}

function recipientList(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value
}

function recipientsAllowed(value: string | readonly string[], allowlist: ReadonlySet<string> | undefined): boolean {
  return allowlist === undefined || recipientList(value).every(address => allowlist.has(recipientKey(address)))
}

function assertAllowedRecipients(value: string | readonly string[], allowlist: ReadonlySet<string> | undefined): string | readonly string[] {
  if (!recipientsAllowed(value, allowlist)) {
    throw new Error("[vitehub] email_send recipient is outside the configured allowlist.")
  }
  return value
}

function emailSendPolicy(allowlist: ReadonlySet<string> | undefined, policy: EmailCapabilityToolPolicy | undefined): EmailCapabilityToolPolicy | undefined {
  if (allowlist === undefined) return policy
  return async (context) => {
    let recipients: string | readonly string[]
    try {
      recipients = validateRecipients((context.input as { to?: unknown } | undefined)?.to)
    }
    catch {
      return "deny"
    }
    if (!recipientsAllowed(recipients, allowlist)) return "deny"
    return typeof policy === "function" ? await policy(context) : policy ?? "allow"
  }
}

function emailSendDescription(recipients: readonly string[] | undefined): string {
  const scope = recipients === undefined
    ? "Recipients are selected in the tool input."
    : recipients.length === 0
      ? "Sending is disabled because the configured recipient allowlist is empty."
      : `Allowed recipients: ${JSON.stringify(recipients)}.`
  return `Send one plain-text email from the configured sender. ${scope} This external side effect reports provider acceptance, not inbox delivery; do not include secrets.`
}

function requireEmailClient(context: AgentCapabilityContext): EmailRuntimeClient {
  const client = requirePrimitive(context, "email")
  if (!client || typeof client !== "object" || typeof (client as { send?: unknown }).send !== "function") {
    throw new Error("[vitehub] email primitive must expose send().")
  }
  return client as EmailRuntimeClient
}

export function email(options: EmailCapabilityOptions): AgentCapabilityDefinition {
  const from = nonEmptyString(options?.from, "email({ from })")
  const recipients = normalizeRecipients(options.recipients)
  const recipientAllowlist = recipients === undefined ? undefined : new Set(recipients.map(recipientKey))
  return defineCapability({
    id: "email",
    metadata: recipients === undefined ? undefined : { recipients },
    mode: "write",
    requires: [{ primitive: "email" }],
    tools: (context) => {
      const client = requireEmailClient(context)
      return {
        email_send: defineInternalTool<EmailSendInput>({
          description: emailSendDescription(recipients),
          execute: async ({ subject, text, to }) => await client.send({
            from,
            subject: nonEmptyString(subject, "email_send subject"),
            text: nonEmptyString(text, "email_send text"),
            to: assertAllowedRecipients(validateRecipients(to), recipientAllowlist),
          }),
          inputSchema: emailSendInputSchema,
          name: "email_send",
          policy: emailSendPolicy(recipientAllowlist, options.policy),
        }),
      }
    },
  })
}
