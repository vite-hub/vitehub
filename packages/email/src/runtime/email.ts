import definition from "#vitehub/email/definition"

import { createEmail } from "../client.ts"
import { emailErrorDiagnostics } from "../error-diagnostics.ts"

import type { EmailClient } from "../types.ts"

const runtimeDefinition = Symbol.for("vitehub.email.definition")
let client = definition ? createEmail(definition) : undefined

export const email: EmailClient = {
  async send(message) {
    const generated = (globalThis as typeof globalThis & { [runtimeDefinition]?: typeof definition })[runtimeDefinition]
    client ??= generated ? createEmail(generated) : undefined
    // A missing provider is a config error, so it throws.
    if (!client) throw emailErrorDiagnostics.EMAIL_NOT_CONFIGURED({})
    return await client.send(message)
  },
}
