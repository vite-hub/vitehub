import { emailErrorDiagnostics } from "./error-diagnostics.ts"

import type { EmailDriver, EmailDriverSource } from "./types.ts"

function assertEmailDriver(value: unknown): asserts value is EmailDriver {
  if (!value || typeof value !== "object") throw emailErrorDiagnostics.EMAIL_INVALID_DRIVER({ problem: "not-object" })
  // SAFETY: The object check permits field inspection; the required name and send fields are validated below before use.
  const driver = value as Partial<EmailDriver>
  if (typeof driver.name !== "string" || driver.name.trim().length === 0) throw emailErrorDiagnostics.EMAIL_INVALID_DRIVER({ problem: "name" })
  if (typeof driver.send !== "function") throw emailErrorDiagnostics.EMAIL_INVALID_DRIVER({ problem: "send" })
}

function withInitialization(driver: EmailDriver): EmailDriver {
  let initialization: Promise<void> | undefined
  return {
    name: driver.name,
    initialize() {
      initialization ??= Promise.resolve().then(() => driver.initialize?.()).catch((error: unknown) => {
        initialization = undefined
        throw error
      })
      return initialization
    },
    send: (message, context) => driver.send(message, context),
  }
}

/**
 * Owns driver validation and initialization for clients and delivery adapters.
 * Objects share initialization, including concurrent sends, and retry after failure.
 * Factories create a fresh lifecycle on each resolution, including request-scoped drivers.
 */
export function createEmailDriverResolver(source: EmailDriverSource): () => Promise<EmailDriver> {
  if (typeof source !== "function") {
    assertEmailDriver(source)
    const driver = withInitialization(source)
    return async () => driver
  }
  return async () => {
    const driver = await source()
    assertEmailDriver(driver)
    return withInitialization(driver)
  }
}
