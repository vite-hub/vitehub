import { emailError, isEmailError } from "./errors.ts"
import { isEmailProviderError } from "./provider.ts"
import { createEmailDriverResolver } from "./driver.ts"
import { applyUnsubscribe } from "./drivers/shared.ts"

import type { EmailClient, EmailDefinition, EmailMessage, EmailProviderErrorCode, EmailSendResult } from "./types.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"

const errorCodes: Record<EmailProviderErrorCode, "EMAIL_AUTHENTICATION" | "EMAIL_NETWORK" | "EMAIL_NOT_CONFIGURED" | "EMAIL_PROVIDER_FAILED" | "EMAIL_RATE_LIMITED" | "EMAIL_TIMEOUT"> = {
  AUTH: "EMAIL_AUTHENTICATION",
  CANCELLED: "EMAIL_PROVIDER_FAILED",
  INVALID_OPTIONS: "EMAIL_NOT_CONFIGURED",
  NETWORK: "EMAIL_NETWORK",
  PROVIDER: "EMAIL_PROVIDER_FAILED",
  RATE_LIMIT: "EMAIL_RATE_LIMITED",
  TIMEOUT: "EMAIL_TIMEOUT",
  UNSUPPORTED: "EMAIL_PROVIDER_FAILED",
}

export function createEmail(options: EmailDefinition): EmailClient {
  if (!options || typeof options !== "object" || !Object.hasOwn(options, "driver")) throw emailErrorDiagnostics.EMAIL_R0004({ message: "`createEmail()` expects an object with a driver." })
  const resolveDriver = createEmailDriverResolver(options.driver)

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      let driverName = "unknown"
      try {
        const driver = await resolveDriver()
        driverName = driver.name
        await driver.initialize?.()
        const preparedMessage = applyUnsubscribe(message, driver.name)
        const result = await driver.send(preparedMessage, { attempt: 1, driver: driver.name, meta: {}, signal: undefined, stream: preparedMessage.stream })
        if (result.error) throw result.error
        if (typeof result.data.id !== "string" || result.data.id.trim().length === 0) {
          throw emailError("EMAIL_PROVIDER_FAILED", `[vitehub] Email driver ${driverName} returned an invalid message id.`, { driver: driverName })
        }
        return { driver: driverName, id: result.data.id }
      }
      catch (error) {
        if (isEmailError(error)) throw error
        if (isEmailProviderError(error)) driverName = error.driver
        throw emailError(
          isEmailProviderError(error) ? errorCodes[error.code] : "EMAIL_PROVIDER_FAILED",
          `[vitehub] Email delivery failed through ${driverName}.`,
          { cause: error, driver: driverName },
        )
      }
    },
  }
}
