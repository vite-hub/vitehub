import { isRuntimeDiagnostic } from "@vite-hub/runtime"

import { emailProviderError, isEmailProviderError } from "./provider.ts"
import { createEmailDriverResolver } from "./driver.ts"
import { applyUnsubscribe } from "./drivers/shared.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"

import type { ResultError } from "@vite-hub/runtime"
import type { EmailClient, EmailDefinition, EmailErrorCode, EmailProviderError, EmailProviderErrorCode } from "./types.ts"

const errorCodes: Record<Exclude<EmailProviderErrorCode, "NOT_CONFIGURED">, EmailErrorCode> = {
  AUTH: "EMAIL_AUTHENTICATION",
  CANCELLED: "EMAIL_PROVIDER_FAILED",
  INVALID_OPTIONS: "EMAIL_INVALID_MESSAGE",
  NETWORK: "EMAIL_NETWORK",
  PROVIDER: "EMAIL_PROVIDER_FAILED",
  RATE_LIMIT: "EMAIL_RATE_LIMITED",
  TIMEOUT: "EMAIL_TIMEOUT",
  UNSUPPORTED: "EMAIL_PROVIDER_FAILED",
}

const renderFirst = "Render it yourself and pass the result as `html` or `text`."
// Fields that no shipped driver sends. Untyped callers can still pass them, so `send()` tells what to write instead.
const removedFields: Record<string, string> = {
  amp: "Send the HTML version as `html`.",
  dsn: "Remove it.",
  handlebars: renderFirst,
  handlebarsVars: renderFirst,
  jsx: renderFirst,
  liquid: renderFirst,
  liquidVars: renderFirst,
  locale: "Render the message in that locale, and remove `locale`.",
  mjml: renderFirst,
  personalizations: "Send one message per recipient with `to`, `cc`, `bcc`, and `subject`.",
  preheader: "Put the preview text at the start of `html`.",
  raw: "Pass `text`, `html`, `headers`, and `attachments`.",
  react: renderFirst,
  sandbox: "Use a test recipient or a test account of the provider.",
  stream: "Remove it.",
  template: renderFirst,
  tracking: "Set tracking in the provider dashboard.",
}

/** Returns why ViteHub cannot send the message, or `undefined` when the message is valid. */
function invalidMessage(message: unknown, driver: string): EmailProviderError | undefined {
  if (!message || typeof message !== "object") return emailProviderError(driver, "INVALID_OPTIONS", "The message must be an object.")
  const removed = Object.entries(message).find(([field, value]) => value !== undefined && Object.hasOwn(removedFields, field))?.[0]
  if (removed) return emailProviderError(driver, "INVALID_OPTIONS", `ViteHub Email does not send \`${removed}\`. ${removedFields[removed]}`)
  const html = "html" in message ? message.html : undefined
  const text = "text" in message ? message.text : undefined
  if (typeof html !== "string" && typeof text !== "string") return emailProviderError(driver, "INVALID_OPTIONS", "The message has no body. Set `text`, `html`, or both.")
  return undefined
}

const configErrorCodes = new Set(["EMAIL_INVALID_DRIVER", "EMAIL_NOT_CONFIGURED"])

/** Maps a driver failure to the error that `send()` returns. Invalid driver options throw `EMAIL_NOT_CONFIGURED`. */
function sendError(error: unknown, driver: string): ResultError<EmailErrorCode> {
  if (isRuntimeDiagnostic(error) && configErrorCodes.has(error.code)) throw error
  if (!isEmailProviderError(error)) return emailErrorDiagnostics.EMAIL_PROVIDER_FAILED({ cause: error, driver })
  if (error.code === "NOT_CONFIGURED") throw emailErrorDiagnostics.EMAIL_NOT_CONFIGURED({ cause: error, driver: error.driver })
  return emailErrorDiagnostics[errorCodes[error.code]]({ cause: error, driver: error.driver })
}

export function createEmail(options: EmailDefinition): EmailClient {
  if (!options || typeof options !== "object" || !Object.hasOwn(options, "driver")) throw emailErrorDiagnostics.EMAIL_INVALID_DRIVER({ problem: "definition" })
  const resolveDriver = createEmailDriverResolver(options.driver)

  return {
    async send(message) {
      let driverName = "unknown"
      try {
        const driver = await resolveDriver()
        driverName = driver.name
        const invalid = invalidMessage(message, driver.name)
        if (invalid) return [sendError(invalid, driverName), undefined]
        await driver.initialize?.()
        const preparedMessage = applyUnsubscribe(message, driver.name)
        const result = await driver.send(preparedMessage, { attempt: 1, driver: driver.name, meta: {}, signal: undefined })
        if (result.error) return [sendError(result.error, driverName), undefined]
        if (typeof result.data.id !== "string" || result.data.id.trim().length === 0) {
          const cause = new Error(`The ${driverName} Email driver returned an invalid message id.`)
          return [emailErrorDiagnostics.EMAIL_PROVIDER_FAILED({ cause, driver: driverName }), undefined]
        }
        return [undefined, { driver: driverName, id: result.data.id }]
      }
      catch (error) {
        return [sendError(error, driverName), undefined]
      }
    },
  }
}
