import definition from "#vitehub/email/definition"

import { createEmail } from "../client.ts"
import { emailError } from "../errors.ts"

import type { EmailClient, EmailMessage, EmailSendResult } from "../types.ts"

const runtimeDefinition = Symbol.for("vitehub.email.definition")
let client = definition ? createEmail(definition) : undefined

export const email: EmailClient = {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    const generated = (globalThis as typeof globalThis & { [runtimeDefinition]?: typeof definition })[runtimeDefinition]
    client ??= generated ? createEmail(generated) : undefined
    if (!client) {
      throw emailError(
        "EMAIL_NOT_CONFIGURED",
        "[vitehub] No Email provider is configured. Set `vitehub({ email: { driver, options } })`.",
      )
    }
    return await client.send(message)
  },
}
