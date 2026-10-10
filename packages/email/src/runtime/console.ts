import * as v from "valibot"
import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"

import { emailDevHeader, emailDevHeaderValue } from "../dev.ts"
import { getEmailOutbox } from "./outbox.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"
import type { ViteHubDefinitionField } from "@vite-hub/internal/inspect"
import type { EmailDevRequestBody } from "../dev.ts"
import type { EmailOutboxDelivery, EmailOutboxMessage } from "./outbox.ts"

export type { EmailOutboxAttachment, EmailOutboxDelivery, EmailOutboxMessage } from "./outbox.ts"

/** One row of `vitehub email outbox list`. Bodies, headers, and attachments are not included. */
export interface EmailOutboxListItem {
  attachments: number
  capturedAt: string
  delivery: EmailOutboxDelivery
  from: string
  id: string
  provider: string
  subject: string
  to: string[]
}

export interface EmailOutboxList {
  /** Number of messages that the outbox keeps. `null` until the first send creates the outbox. */
  limit: number | null
  /** Newest message first. */
  messages: EmailOutboxListItem[]
}

/** Longest HTML source that one Console record shows. Use `vitehub email outbox show <id> --html` for the full source. */
export const emailConsoleHtmlSourceLimit = 4000

function listItem(message: EmailOutboxMessage): EmailOutboxListItem {
  return {
    attachments: message.attachments.length,
    capturedAt: message.capturedAt,
    delivery: message.delivery,
    from: message.from,
    id: message.id,
    provider: message.provider,
    subject: message.subject,
    to: message.to,
  }
}

/** Lists the messages of the development outbox, newest first. */
export function listEmailOutbox(runtimeId?: string): EmailOutboxList {
  const outbox = getEmailOutbox(runtimeId)
  return { limit: outbox?.limit ?? null, messages: (outbox?.list() ?? []).map(listItem) }
}

/** Returns one captured message, or `undefined` when the outbox has no message with this id. */
export function getEmailOutboxMessage(id: string, runtimeId?: string): EmailOutboxMessage | undefined {
  return getEmailOutbox(runtimeId)?.get(id)
}

/** Removes every captured message. Returns the number of removed messages. */
export function clearEmailOutbox(runtimeId?: string): number {
  return getEmailOutbox(runtimeId)?.clear() ?? 0
}

/** Short text for a delivery state. */
export function formatEmailOutboxDelivery(delivery: EmailOutboxDelivery): string {
  switch (delivery.status) {
    case "pending":
      return "Sending"
    case "captured":
      return "Captured only"
    case "sent":
      return `Sent (${delivery.id})`
    case "failed":
      return `Failed${delivery.error.code ? ` (${delivery.error.code})` : ""}: ${delivery.error.message}`
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function consoleRecord(message: EmailOutboxMessage): ViteHubConsoleRecord {
  const headers = Object.entries(message.headers)
  const fields: ViteHubDefinitionField[] = [
    { label: "From", value: message.from },
    { label: "To", value: message.to.join(", ") },
    ...(message.cc?.length ? [{ label: "Cc", value: message.cc.join(", ") }] : []),
    ...(message.bcc?.length ? [{ label: "Bcc", value: message.bcc.join(", ") }] : []),
    ...(message.replyTo?.length ? [{ label: "Reply-To", value: message.replyTo.join(", ") }] : []),
    { label: "Subject", value: message.subject },
    ...(message.preheader ? [{ label: "Preheader", value: message.preheader }] : []),
    { label: "Provider", value: message.provider },
    { label: "Delivery", value: formatEmailOutboxDelivery(message.delivery) },
    { label: "Captured", value: message.capturedAt },
    ...(message.scheduledAt ? [{ label: "Scheduled at", value: message.scheduledAt }] : []),
    ...(message.stream ? [{ label: "Stream", value: message.stream }] : []),
    ...(message.template ? [{ label: "Provider template", value: message.template }] : []),
    { label: "Headers", value: headers.length ? headers.map(([name, value]) => `${name}: ${value}`).join("\n") : "None" },
    {
      label: "Attachments",
      value: message.attachments.length
        ? message.attachments.map(attachment => `${attachment.filename} (${[attachment.contentType, formatSize(attachment.size), attachment.disposition].filter(Boolean).join(", ")})`).join("\n")
        : "None",
    },
    ...(message.tags?.length ? [{ label: "Tags", value: message.tags.map(tag => `${tag.name}=${tag.value}`).join(", ") }] : []),
    ...(message.metadata ? [{ label: "Metadata", value: Object.entries(message.metadata).map(([key, value]) => `${key}=${value}`).join("\n") }] : []),
    { label: "Text body", value: message.text ?? "None" },
    {
      // The Console shows HTML as escaped source text. It never renders the HTML.
      label: "HTML source",
      value: message.html === undefined
        ? "None"
        : message.html.length > emailConsoleHtmlSourceLimit
          ? `${message.html.slice(0, emailConsoleHtmlSourceLimit)}\n... ${message.html.length - emailConsoleHtmlSourceLimit} more characters. Use \`vitehub email outbox show ${message.id} --html\`.`
          : message.html,
    },
  ]
  return {
    cells: {
      captured: message.capturedAt,
      delivery: formatEmailOutboxDelivery(message.delivery),
      provider: message.provider,
      subject: message.subject,
      to: message.to.join(", "),
    },
    fields,
    id: message.id,
  }
}

/**
 * Console runtime reader. Returns one record for each message in the development outbox, newest first. The Console
 * calls it on each request. Without an outbox, for example in build output, it returns no records.
 */
export function readEmailOutboxConsoleRecords(runtimeId?: string): ViteHubConsoleRecord[] {
  return (getEmailOutbox(runtimeId)?.list() ?? []).map(consoleRecord)
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string): Response {
  const error: { code?: string, message: string } = { message }
  if (code) error.code = code
  return json({ error }, status)
}

async function readBody(request: Request): Promise<EmailDevRequestBody | undefined> {
  const body: unknown = await request.json().catch(() => undefined)
  const parsed = v.safeParse(v.object({ operation: v.picklist(["list", "get", "clear"]), id: v.optional(v.pipe(v.string(), v.minLength(1))) }), body)
  return parsed.success ? parsed.output : undefined
}

function runOperation(body: EmailDevRequestBody, runtimeId?: string): Response {
  switch (body.operation) {
    case "list":
      return json(listEmailOutbox(runtimeId))
    case "get": {
      if (!body.id) return failure("The get operation requires an id.", 400)
      const message = getEmailOutboxMessage(body.id, runtimeId)
      return message
        ? json({ message })
        : failure("Outbox message was not found. The outbox keeps only recent messages and a restart clears it.", 404, "EMAIL_OUTBOX_MESSAGE_NOT_FOUND")
    }
    case "clear":
      return json({ cleared: clearEmailOutbox(runtimeId) })
  }
}

const devHeaders = { header: emailDevHeader, headerValue: emailDevHeaderValue, label: "Email Dev" }

/**
 * Handles one outbox operation from `vitehub email outbox`. The Vite Development Server forwards the request into the
 * Nitro runtime, so the operation reads the same outbox as `email.send()`.
 *
 * The request must carry the Email dev header, must not come from another origin, and must use JSON.
 */
export async function handleEmailDevRequest(request: Request, runtimeContext?: string | { runtimeId?: string }): Promise<Response> {
  const runtimeId = v.is(v.string(), runtimeContext) ? runtimeContext : runtimeContext?.runtimeId
  const { rejection } = await validateViteHubNitroDevRequest(request, devHeaders)
  if (rejection) return rejection
  const body = await readBody(request)
  if (!body) return failure("The Email Dev request body is invalid.", 400)
  return runOperation(body, runtimeId)
}

/**
 * Handles `vitehub email outbox` requests when the application sets `email.outbox: false`. Each valid request gets
 * `409` with `EMAIL_OUTBOX_DISABLED`.
 */
export async function handleDisabledEmailDevRequest(request: Request): Promise<Response> {
  const { rejection } = await validateViteHubNitroDevRequest(request, devHeaders)
  if (rejection) return rejection
  return failure("The Email development outbox is disabled. Remove `email.outbox: false` to capture messages in `vite dev`.", 409, "EMAIL_OUTBOX_DISABLED")
}
