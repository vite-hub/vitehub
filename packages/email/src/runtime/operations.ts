import { resolve } from "node:path"

import { previewEmailTemplate } from "../preview.ts"
import { getEmailTemplateRoots } from "../roots.ts"
import { toEmailOutboxListItem } from "./console.ts"
import { getActiveEmailOutbox, isEmailOutboxDisabled } from "./outbox.ts"

import type { EmailPreview } from "../preview.ts"
import type { EmailOutboxList } from "./console.ts"
import type { EmailOutboxMessage } from "./outbox.ts"

/** A failure with the fields that every surface reports. */
export class EmailOperationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fix?: string) {
    super(message)
  }
}

function outbox() {
  if (isEmailOutboxDisabled()) throw new EmailOperationError("The Email development outbox is disabled.", 409, "EMAIL_OUTBOX_DISABLED", "Remove `email.outbox: false` to capture messages in `vite dev`.")
  return getActiveEmailOutbox()
}

/** Newest message first. `limit` is `null` until the first send creates the outbox. */
export function listEmailOutboxMessages(): EmailOutboxList {
  const current = outbox()
  return { limit: current?.limit ?? null, messages: (current?.list() ?? []).map(toEmailOutboxListItem) }
}

export function showEmailOutboxMessage(id: string): { message: EmailOutboxMessage } {
  const message = outbox()?.get(id)
  if (!message) throw new EmailOperationError("Outbox message was not found. The outbox keeps only recent messages and a restart clears it.", 404, "EMAIL_OUTBOX_MESSAGE_NOT_FOUND", "Run `vitehub email outbox list` for the ids that the outbox holds.")
  return { message }
}

export function clearEmailOutboxMessages(): { cleared: number } {
  return { cleared: outbox()?.clear() ?? 0 }
}

/** Renders a template of the running app. The roots come from the Vite plugin; without it they default to `server/emails`. */
export async function previewEmail(template: string, data?: Record<string, unknown>): Promise<EmailPreview> {
  const rootDir = process.cwd()
  return await previewEmailTemplate(getEmailTemplateRoots() ?? [resolve(rootDir, "server", "emails")], rootDir, template, data)
}
