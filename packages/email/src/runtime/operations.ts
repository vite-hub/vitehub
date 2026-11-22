import { renderEmailMarkdown } from "../markdown.ts"
import { emailErrorDiagnostics } from "../error-diagnostics.ts"
import { emailTemplateNotFound } from "../preview.ts"
import { toEmailOutboxListItem } from "./console.ts"
import { getActiveEmailOutbox, isEmailOutboxDisabled } from "./outbox.ts"

import type { EmailPreview } from "../preview.ts"
import type { EmailOutboxList } from "./console.ts"
import type { EmailOutboxMessage } from "./outbox.ts"

const operationStatus = { EMAIL_OUTBOX_DISABLED: 409, EMAIL_OUTBOX_MESSAGE_NOT_FOUND: 404 } as const

function withStatus<TError extends { code: keyof typeof operationStatus }>(error: TError): TError {
  return Object.assign(error, { status: operationStatus[error.code] })
}

function outbox() {
  if (isEmailOutboxDisabled()) throw withStatus(emailErrorDiagnostics.EMAIL_OUTBOX_DISABLED())
  return getActiveEmailOutbox()
}

/** Newest message first. `limit` is `null` until the first send creates the outbox. */
export function listEmailOutboxMessages(): EmailOutboxList {
  const current = outbox()
  return { limit: current?.limit ?? null, messages: (current?.list() ?? []).map(toEmailOutboxListItem) }
}

export function showEmailOutboxMessage(id: string): { message: EmailOutboxMessage } {
  const message = outbox()?.get(id)
  if (!message) throw withStatus(emailErrorDiagnostics.EMAIL_OUTBOX_MESSAGE_NOT_FOUND())
  return { message }
}

export function clearEmailOutboxMessages(): { cleared: number } {
  return { cleared: outbox()?.clear() ?? 0 }
}

/** Renders a template carried in generated host output, including in workers without the application's source files. */
export async function previewEmail(template: string, data?: Record<string, unknown>): Promise<EmailPreview> {
  const { emailPreview } = await import("#vitehub/email/definition")
  const entry = emailPreview.templates.find(entry => entry.name === template)
  if (!entry) throw emailTemplateNotFound(template, emailPreview.roots, ".", emailPreview.templates.map(entry => entry.name))
  const rendered = await renderEmailMarkdown(entry.source, { data })
  return { file: entry.file, html: rendered.html, template: entry.name, text: rendered.text }
}
