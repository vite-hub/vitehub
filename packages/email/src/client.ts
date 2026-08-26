import { emailError, isEmailError } from "./errors.ts"
import { isEmailProviderError } from "./provider.ts"

import type { EmailClient, EmailDefinition, EmailDriver, EmailDriverSource, EmailMessage, EmailProviderErrorCode, EmailSendResult } from "./types.ts"

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

function assertEmailDriver(value: unknown): asserts value is EmailDriver {
  if (!value || typeof value !== "object") throw new TypeError("Email driver must be an object.")
  const driver = value as Partial<EmailDriver>
  if (typeof driver.name !== "string" || driver.name.trim().length === 0) throw new TypeError("Email driver name must be a non-empty string.")
  if (typeof driver.send !== "function") throw new TypeError("Email driver send must be a function.")
}

function resolveEmailDriver(source: EmailDriverSource): Promise<EmailDriver> {
  return Promise.resolve(typeof source === "function" ? source() : source).then((driver) => {
    assertEmailDriver(driver)
    return driver
  })
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase()
  return Object.keys(headers).some(header => header.toLowerCase() === normalizedName)
}

function prepareMessage(message: EmailMessage): EmailMessage {
  const headers = { ...message.headers }
  if (message.unsubscribe) {
    const { mailto, oneClick, url } = message.unsubscribe
    const values = [url ? `<${url}>` : undefined, mailto ? `<mailto:${mailto}>` : undefined].filter(value => value !== undefined)
    if (values.length > 0 && !hasHeader(headers, "list-unsubscribe")) headers["List-Unsubscribe"] = values.join(", ")
    if ((oneClick ?? Boolean(url)) && url && !hasHeader(headers, "list-unsubscribe-post")) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
  }
  return {
    ...message,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

export function createEmail(options: EmailDefinition): EmailClient {
  if (!options || typeof options !== "object" || !("driver" in options)) throw new TypeError("`createEmail()` expects an object with a driver.")
  if (typeof options.driver !== "function") assertEmailDriver(options.driver)
  let initialization: Promise<void> | undefined

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      let driverName = "unknown"
      try {
        const driver = await resolveEmailDriver(options.driver)
        driverName = driver.name
        if (typeof options.driver === "function") {
          await driver.initialize?.()
        }
        else {
          initialization ??= Promise.resolve(driver.initialize?.()).catch((error: unknown) => {
            initialization = undefined
            throw error
          })
          await initialization
        }
        const preparedMessage = prepareMessage(message)
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
