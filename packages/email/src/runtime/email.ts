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
        "[vitehub] No Email Definition was discovered. Add `server/email.ts` or `server.email.ts`.",
      )
    }
    return await discoveredClient.send(message)
  },
}
