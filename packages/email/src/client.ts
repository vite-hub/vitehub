import { Diagnostic } from "nostics"

import { isEmailProviderError } from "./provider.ts"
import { createEmailDriverResolver } from "./driver.ts"
import { applyUnsubscribe } from "./drivers/shared.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"

import type { ResultError } from "@vite-hub/runtime"
import type { EmailClient, EmailDefinition, EmailErrorCode, EmailProviderErrorCode } from "./types.ts"

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

const configErrorCodes = new Set(["EMAIL_INVALID_DRIVER", "EMAIL_NOT_CONFIGURED"])

/** Maps a driver failure to the error that `send()` returns. Invalid driver options throw `EMAIL_NOT_CONFIGURED`. */
function sendError(error: unknown, driver: string): ResultError<EmailErrorCode> {
  if (error instanceof Diagnostic && configErrorCodes.has(error.code)) throw error
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
        await driver.initialize?.()
        const preparedMessage = applyUnsubscribe(message, driver.name)
        const result = await driver.send(preparedMessage, { attempt: 1, driver: driver.name, meta: {}, signal: undefined, stream: preparedMessage.stream })
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
