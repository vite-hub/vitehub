import { createEmail as createUnemail } from "unemail"

import { emailError, isEmailError } from "./errors.ts"

import type { EmailClient, EmailDefinition, EmailDriver, EmailDriverSource, EmailMessage, EmailSendResult } from "./types.ts"

const errorCodes = {
  AUTH: "EMAIL_AUTHENTICATION",
  CANCELLED: "EMAIL_PROVIDER_FAILED",
  INVALID_OPTIONS: "EMAIL_NOT_CONFIGURED",
  NETWORK: "EMAIL_NETWORK",
  PROVIDER: "EMAIL_PROVIDER_FAILED",
  RATE_LIMIT: "EMAIL_RATE_LIMITED",
  TIMEOUT: "EMAIL_TIMEOUT",
  UNSUPPORTED: "EMAIL_PROVIDER_FAILED",
} as const

function assertEmailDriver(value: unknown): asserts value is EmailDriver {
  if (!value || typeof value !== "object") {
    throw new TypeError("Email driver must be an object.")
  }

  const driver = value as Partial<EmailDriver>
  if (typeof driver.name !== "string" || driver.name.trim().length === 0) {
    throw new TypeError("Email driver name must be a non-empty string.")
  }
  if (typeof driver.send !== "function") {
    throw new TypeError("Email driver send must be a function.")
  }
}

function resolveEmailDriver(source: EmailDriverSource): Promise<EmailDriver> {
  return Promise.resolve(typeof source === "function" ? source() : source).then((driver) => {
    assertEmailDriver(driver)
    return driver
  })
}

function unemailError(value: unknown): { code: keyof typeof errorCodes; driver: string } | undefined {
  if (!value || typeof value !== "object") return
  const error = value as Record<string, unknown>
  if (error.name !== "EmailError" || typeof error.driver !== "string" || !((error.code as string) in errorCodes)) return
  return error as { code: keyof typeof errorCodes; driver: string }
}

export function createEmail(options: EmailDefinition): EmailClient {
  if (!options || typeof options !== "object" || !("driver" in options)) {
    throw new TypeError("`createEmail()` expects an object with a driver.")
  }
  if (typeof options.driver !== "function") assertEmailDriver(options.driver)
  const stableClient = typeof options.driver === "function" ? undefined : createUnemail({ driver: options.driver })

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      let driverName = "unknown"
      try {
        const client = stableClient ?? createUnemail({ driver: await resolveEmailDriver(options.driver) })
        driverName = client.driver.name
        const result = await client.send(message)
        if (result.error) throw result.error
        if (typeof result.data.id !== "string" || result.data.id.trim().length === 0) {
          throw emailError("EMAIL_PROVIDER_FAILED", `[vitehub] Email driver ${driverName} returned an invalid message id.`, {
            driver: driverName,
          })
        }
        return { driver: driverName, id: result.data.id }
      } catch (error) {
        if (isEmailError(error)) throw error
        const providerError = unemailError(error)
        if (providerError) driverName = providerError.driver
        throw emailError(
          providerError ? errorCodes[providerError.code] : "EMAIL_PROVIDER_FAILED",
          `[vitehub] Email delivery failed through ${driverName}.`,
          {
            cause: error,
            driver: driverName,
          },
        )
      }
    },
  }
}
