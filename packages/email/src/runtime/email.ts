import definition from "#vitehub/email/definition"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { createEmail } from "../client.ts"
import { emailErrorDiagnostics } from "../error-diagnostics.ts"
import { createTestEmail } from "../test.ts"

import type { Result } from "@vite-hub/runtime"
import type { EmailClient, EmailEnvelope, EmailMessage, EmailSendMessage, EmailTemplateMessage } from "../types.ts"

type TemplateSend = Omit<EmailEnvelope, "subject"> & { data?: Record<string, unknown>, subject?: string, template: string }

const runtimeDefinition = Symbol.for("vitehub.email.definition")
let client = definition ? createEmail(definition) : undefined

function isTemplateMessage(message: EmailSendMessage): message is EmailTemplateMessage {
  return message.template !== undefined
}

async function renderTemplate(message: TemplateSend): Promise<Result<EmailMessage, "EMAIL_TEMPLATE_RENDER_FAILED">> {
  const { data, subject, template, ...envelope } = message
  const { emailPreview, renderEmailTemplate } = await import("#vitehub/email/definition")
  const entry = emailPreview.templates.find(entry => entry.name === template)
  if (!entry || !renderEmailTemplate) {
    throw emailErrorDiagnostics.EMAIL_TEMPLATE_NOT_FOUND({
      available: emailPreview.templates.map(entry => entry.name).join(", "),
      roots: emailPreview.roots.join(", ") || "server/emails",
      template,
    })
  }
  let rendered
  try {
    rendered = await renderEmailTemplate(entry.source, data, entry.name)
  }
  catch (cause) {
    return [emailErrorDiagnostics.EMAIL_TEMPLATE_RENDER_FAILED({ cause, template }), undefined]
  }
  const resolvedSubject = subject ?? rendered.subject
  if (resolvedSubject === undefined) throw emailErrorDiagnostics.EMAIL_TEMPLATE_SUBJECT_REQUIRED({ template })
  return [undefined, { ...envelope, html: rendered.html, subject: resolvedSubject, text: rendered.text }]
}

const generatedDefinition = () => (globalThis as typeof globalThis & { [runtimeDefinition]?: typeof definition })[runtimeDefinition]

/**
 * Sends messages through the provider of `vitehub({ email })`. A `template` send renders a template of `server/emails`
 * once, and uses its subject unless the message passes `subject`.
 */
export const email: EmailClient<EmailSendMessage> & { readonly canSend: boolean } = {
  get canSend() {
    const current = definition ?? generatedDefinition()
    return current !== undefined && current.canSend !== false
  },
  async send(input) {
    const generated = generatedDefinition()
    client ??= generated ? createEmail(generated) : undefined
    if (!client) throw emailErrorDiagnostics.EMAIL_NOT_CONFIGURED({})
    let message: EmailMessage
    if (isTemplateMessage(input)) {
      const [error, rendered] = await renderTemplate(input)
      if (error) return [error, undefined]
      message = rendered
    }
    else message = input
    const test = getViteHubTestMode()
    if (test) return await test.backend("email", createTestEmail).send(message)
    return await client.send(message)
  },
}
