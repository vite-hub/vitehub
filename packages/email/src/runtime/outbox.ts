import * as v from "valibot"
import { redactInspectionText, redactInspectionValue } from "@vite-hub/internal/inspect"
import { getViteHubErrorShape } from "@vite-hub/runtime"

import { createEmailDriverResolver } from "../driver.ts"
import { addresses, formatAddress } from "../drivers/shared.ts"

import type { EmailAddressList, EmailAttachment, EmailDriver, EmailDriverResult, EmailDriverSource, EmailMessage } from "../types.ts"

/** Default number of messages that the development outbox keeps. */
export const defaultEmailOutboxLimit = 50
/** Largest `outbox.limit` value. */
export const maximumEmailOutboxLimit = 1000

/** Metadata of one attachment. The outbox does not keep attachment content. */
export interface EmailOutboxAttachment {
  cid?: string
  contentType?: string
  disposition?: "attachment" | "inline"
  filename: string
  /** Content size in bytes. */
  size: number
}

/** Delivery state of one captured message. */
export type EmailOutboxDelivery =
  /** Capture-only mode. No provider request was made. */
  | { status: "captured" }
  /** The provider has not completed delivery yet. */
  | { status: "pending" }
  /** The provider accepted the message. */
  | { id: string, status: "sent" }
  /** The provider rejected the message or the provider driver failed. The message is redacted. */
  | { error: { code?: string, message: string }, status: "failed" }

/** Serializable copy of one message that `email.send()` received in `vite dev`. */
export interface EmailOutboxMessage {
  attachments: EmailOutboxAttachment[]
  bcc?: string[]
  /** ISO time when the outbox captured the message. */
  capturedAt: string
  cc?: string[]
  delivery: EmailOutboxDelivery
  from: string
  /** Message headers after ViteHub adds unsubscribe headers. Values with a secret name are redacted. */
  headers: Record<string, string>
  /** Rendered HTML body. The outbox keeps it as a string and never renders it. */
  html?: string
  /** Outbox id, for example `outbox-3`. The id is not a provider message id. */
  id: string
  metadata?: Record<string, string>
  preheader?: string
  /** Provider driver that sends the message, or that would send it in capture-only mode. */
  provider: string
  replyTo?: string[]
  scheduledAt?: string
  stream?: string
  subject: string
  tags?: Array<{ name: string, value: string }>
  /** Provider template id or alias, when the message uses one. */
  template?: string
  text?: string
  to: string[]
}

export interface EmailOutboxStore {
  clear: () => number
  get: (id: string) => EmailOutboxMessage | undefined
  /** Newest message first. */
  list: () => EmailOutboxMessage[]
  readonly limit: number
}

interface EmailOutboxState {
  limit: number
  messages: EmailOutboxMessage[]
  nextId: number
}

// The generated Email definition and the Console reader are separate bundles in one runtime. They share this state.
const outboxState = Symbol.for("vitehub.email.outbox")

type OutboxGlobal = typeof globalThis & { [outboxState]?: Map<string, EmailOutboxState> }

function state(runtimeId = "default"): EmailOutboxState | undefined {
  // SAFETY: Generated Email bundles share this optional symbol-keyed registry.
  return (globalThis as OutboxGlobal)[outboxState]?.get(runtimeId)
}

/** Removes only this runtime's messages and identity during development server teardown. */
export function disposeEmailOutbox(runtimeId: string): void {
  const current = state(runtimeId)
  current?.messages.splice(0)
  // SAFETY: The owner-created registry shares generated outbox state between bundles.
  ;(globalThis as OutboxGlobal)[outboxState]?.delete(runtimeId)
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return defaultEmailOutboxLimit
  return Math.min(Math.max(Math.trunc(value), 1), maximumEmailOutboxLimit)
}

function installState(limit: number, runtimeId: string): EmailOutboxState {
  const current = state(runtimeId)
  if (current) {
    current.limit = limit
    current.messages.splice(limit)
    return current
  }
  const created: EmailOutboxState = { limit, messages: [], nextId: 1 }
  // SAFETY: This owner installs the optional symbol-keyed registry shared by generated bundles.
  const global = globalThis as OutboxGlobal
  global[outboxState] ??= new Map()
  global[outboxState].set(runtimeId, created)
  return created
}

/**
 * Returns the development outbox of this runtime, or `undefined` when no outbox is installed. The outbox exists only
 * after the first send in `vite dev` with `outbox` enabled.
 */
export function getEmailOutbox(runtimeId = "default"): EmailOutboxStore | undefined {
  const current = state(runtimeId)
  if (!current) return
  return {
    clear() {
      const count = current.messages.length
      current.messages.splice(0)
      return count
    },
    get: id => current.messages.find(message => message.id === id),
    get limit() {
      return current.limit
    },
    list: () => [...current.messages],
  }
}

function addressList(value: EmailAddressList | undefined): string[] | undefined {
  return value === undefined ? undefined : addresses(value).map(formatAddress)
}

function attachmentSize(content: EmailAttachment["content"]): number {
  return v.is(v.string(), content) ? new TextEncoder().encode(content).byteLength : content.byteLength
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    const redacted = redactInspectionValue(value, name)
    return [name, v.is(v.string(), redacted) ? redactInspectionText(redacted) : String(redacted)]
  }))
}

function redactMetadata(metadata: Record<string, string>): Record<string, string> {
  return redactHeaders(metadata)
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function optional<TKey extends string, TValue>(key: TKey, value: TValue | undefined): Partial<Record<TKey, TValue>> {
  // SAFETY: The computed property is exactly key and contains the provided TValue.
  return value === undefined ? {} : { [key]: value } as Record<TKey, TValue>
}

/** Returns the serializable outbox copy of a message. Attachment content is replaced with its size. */
export function summarizeEmailOutboxMessage(
  message: EmailMessage,
  options: { capturedAt: Date, delivery: EmailOutboxDelivery, id: string, provider: string },
): EmailOutboxMessage {
  if (message.personalizations?.length === 1) {
    const personalization = message.personalizations[0]!
    message = { ...message, bcc: personalization.bcc ?? message.bcc, cc: personalization.cc ?? message.cc, subject: personalization.subject ?? message.subject, to: personalization.to }
  }
  const template = message.template?.id ?? message.template?.alias
  return {
    attachments: (message.attachments ?? []).map(attachment => ({
      ...optional("cid", attachment.cid),
      ...optional("contentType", attachment.contentType),
      ...optional("disposition", attachment.disposition),
      filename: attachment.filename,
      size: attachmentSize(attachment.content),
    })),
    ...optional("bcc", addressList(message.bcc)),
    capturedAt: options.capturedAt.toISOString(),
    ...optional("cc", addressList(message.cc)),
    delivery: options.delivery,
    from: formatAddress(message.from),
    headers: redactHeaders(message.headers),
    ...optional("html", message.html),
    id: options.id,
    ...optional("metadata", message.metadata ? redactMetadata(message.metadata) : undefined),
    ...optional("preheader", message.preheader),
    provider: options.provider,
    ...optional("replyTo", addressList(message.replyTo)),
    ...optional("scheduledAt", message.scheduledAt === undefined ? undefined : isoDate(message.scheduledAt)),
    ...optional("stream", message.stream),
    subject: message.subject,
    ...optional("tags", message.tags?.map(tag => ({ name: tag.name, value: tag.value }))),
    ...optional("template", template),
    ...optional("text", message.text),
    to: addressList(message.to) ?? [],
  }
}

function failedDelivery(error: unknown): EmailOutboxDelivery {
  const shape = getViteHubErrorShape(error)
  const coded = v.safeParse(v.object({ code: v.optional(v.string()) }), error)
  const code = shape?.code ?? (coded.success ? coded.output.code : undefined)
  const message = error instanceof Error ? error.message : String(error)
  return { error: { ...optional("code", code), message: redactInspectionText(message) }, status: "failed" }
}

export interface EmailDevOutboxDriverOptions {
  /** `true` sends each message through the provider driver after capture. `false` only captures the message. */
  deliver: boolean
  /** Provider driver. The outbox resolves it only when `deliver` is `true`. */
  driver: EmailDriverSource
  /** Number of messages to keep. The oldest message is removed first. */
  limit?: number
  /** Stable provider driver name, for example `resend`. */
  provider: string
  /** Identity generated for one development runtime. Separate identities never share messages or ids. */
  runtimeId?: string
}

/**
 * Wraps the provider driver with the development outbox. ViteHub installs it only in `vite dev`, never in build
 * output. The outbox keeps messages in memory in the server runtime, so a restart clears it.
 *
 * In capture-only mode the returned driver is named `outbox` and returns `outbox-<n>` ids. The provider driver is not
 * created, so provider options are not resolved or checked.
 */
export async function createEmailDevOutboxDriver(options: EmailDevOutboxDriverOptions): Promise<EmailDriver> {
  const outbox = installState(normalizeLimit(options.limit), options.runtimeId ?? "default")
  const record = (message: EmailMessage, delivery: EmailOutboxDelivery, id = `outbox-${outbox.nextId++}`) => {
    outbox.messages.unshift(summarizeEmailOutboxMessage(message, { capturedAt: new Date(), delivery, id, provider: options.provider }))
    outbox.messages.splice(outbox.limit)
    return outbox.messages[0]!
  }

  if (!options.deliver) {
    return {
      name: "outbox",
      send(message, context) {
        const { id } = record(message, { status: "captured" })
        return { data: { at: new Date(), driver: "outbox", id, stream: context.stream }, error: null }
      },
    }
  }

  let driver: EmailDriver
  try {
    driver = await createEmailDriverResolver(options.driver)()
  }
  catch (error) {
    // Keep the message visible when the provider options cannot be resolved, then report the original failure.
    return {
      name: options.provider,
      send(message) {
        record(message, failedDelivery(error))
        throw error
      },
    }
  }
  return {
    name: driver.name,
    async send(message, context): Promise<EmailDriverResult> {
      const captured = record(message, { status: "pending" })
      let result: EmailDriverResult
      try {
        await driver.initialize?.()
        result = await driver.send(message, context)
      }
      catch (error) {
        captured.delivery = failedDelivery(error)
        throw error
      }
      if (result.error) {
        captured.delivery = failedDelivery(result.error)
      }
      else if (typeof result.data?.id === "string" && result.data.id.trim().length > 0) {
        captured.delivery = { id: result.data.id, status: "sent" }
      }
      else {
        // Keep malformed provider responses out of the successful delivery history.
        captured.delivery = failedDelivery(new Error("Email driver returned an invalid message id."))
      }
      return result
    },
  }
}
