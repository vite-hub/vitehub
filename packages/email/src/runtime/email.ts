import definition from "#vitehub/email/definition"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { createEmail } from "../client.ts"
import { emailErrorDiagnostics } from "../error-diagnostics.ts"
import { createTestEmail } from "../test.ts"

import type { Result } from "@vite-hub/runtime"
import type { EmailClient, EmailEnvelope, EmailMessage, EmailSendMessage, EmailTemplateMessage } from "../types.ts"

const runtimeDefinition = Symbol.for("vitehub.email.definition")
let client = definition ? createEmail(definition) : undefined

// Without templates, `EmailTemplateMessage` is `never`, so a guard narrows where a check of `template` cannot.
function isTemplateMessage(message: EmailSendMessage): message is EmailTemplateMessage {
  return message.template !== undefined
}

/**
 * Renders the template of a message to `html` and `text`. The generated definition loads the renderer on the first
 * template send, and only an app with templates bundles it. An unknown name throws, because the code must change.
 */
async function renderTemplate(message: EmailEnvelope & { data?: Record<string, unknown>, template: string }): Promise<Result<EmailMessage, "EMAIL_TEMPLATE_RENDER_FAILED">> {
  const { data, template, ...envelope } = message
  const { emailPreview, renderEmailTemplate } = await import("#vitehub/email/definition")
  const entry = emailPreview.templates.find(entry => entry.name === template)
  if (!entry || !renderEmailTemplate) {
    throw emailErrorDiagnostics.EMAIL_TEMPLATE_NOT_FOUND({
      available: emailPreview.templates.map(entry => entry.name).join(", "),
      roots: emailPreview.roots.join(", ") || "server/emails",
      template,
    })
  }
  try {
    return [undefined, { ...envelope, ...await renderEmailTemplate(entry.source, data) }]
  }
  catch (cause) {
    return [emailErrorDiagnostics.EMAIL_TEMPLATE_RENDER_FAILED({ cause, template }), undefined]
  }
}

/** Sends messages through the provider of `vitehub({ email })`. `template` sends render a Markdown file of `server/emails`. */
export const email: EmailClient<EmailSendMessage> = {
  async send(input) {
    const generated = (globalThis as typeof globalThis & { [runtimeDefinition]?: typeof definition })[runtimeDefinition]
    client ??= generated ? createEmail(generated) : undefined
    // A missing provider is a config error, so it throws.
    if (!client) throw emailErrorDiagnostics.EMAIL_NOT_CONFIGURED({})
    let message: EmailMessage
    if (isTemplateMessage(input)) {
      const [error, rendered] = await renderTemplate(input)
      if (error) return [error, undefined]
      message = rendered
    }
    else message = input
    // In app tests, the outbox of `vite-hub/test` receives every message, and no provider runs.
    const test = getViteHubTestMode()
    if (test) return await test.backend("email", createTestEmail).send(message)
    return await client.send(message)
  },
}
