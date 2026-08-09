import discoveredDefinition from "#vitehub/email/definition"

import { createEmail } from "../client.ts"
import { emailError } from "../errors.ts"

import type { EmailClient, EmailMessage, EmailSendResult } from "../types.ts"

const discoveredClient = discoveredDefinition ? createEmail(discoveredDefinition) : undefined

export const email: EmailClient = {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!discoveredClient) {
      throw emailError(
        "EMAIL_NOT_CONFIGURED",
        "[vitehub] No Email provider or Definition is configured. Set `vitehub({ email: { driver, options } })` or add `server/email.ts`.",
      )
    }
    return await discoveredClient.send(message)
  },
}
