import type { EmailDefinition, EmailDriver, EmailDriverSource } from "./types.ts"

export function assertEmailDriver(value: unknown): asserts value is EmailDriver {
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

export function defineEmail(definition: EmailDefinition): EmailDefinition {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("`defineEmail()` expects an object with a driver.")
  }
  if (typeof definition.driver !== "function") assertEmailDriver(definition.driver)
  return definition
}

export function resolveEmailDriver(source: EmailDriverSource): Promise<EmailDriver> {
  return Promise.resolve(typeof source === "function" ? source() : source).then((driver) => {
    assertEmailDriver(driver)
    return driver
  })
}
