import discoveredDefinition from "#vitehub/email/definition"

import { createEmail } from "../client.ts"
import { EmailError } from "../errors.ts"

import type { EmailClient, EmailMessage, EmailSendResult } from "../types.ts"

export const email: EmailClient = {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!discoveredDefinition) {
      throw new EmailError(
        "not-configured",
        "[vitehub] No Email Definition was discovered. Add `server/email.ts` or `server.email.ts`.",
      )
    }
    return await createEmail(discoveredDefinition).send(message)
  },
}
