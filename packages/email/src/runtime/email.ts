import definition from "#vitehub/email/definition"

import { createEmail } from "../client.ts"
import { emailError } from "../errors.ts"

import type { EmailClient, EmailMessage, EmailSendResult } from "../types.ts"

const client = definition ? createEmail(definition) : undefined

export const email: EmailClient = {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!client) {
      throw emailError(
        "EMAIL_NOT_CONFIGURED",
        "[vitehub] No Email provider is configured. Set `vitehub({ email: { driver, options } })`.",
      )
    }
    return await client.send(message)
  },
}
