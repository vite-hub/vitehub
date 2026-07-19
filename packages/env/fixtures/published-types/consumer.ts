import { EnvError } from "@vite-hub/env"

import type { EnvErrorCode, EnvErrorOptions } from "@vite-hub/env"

const code = "ENV_REQUIRED_MISSING" satisfies EnvErrorCode
"ENV_SOURCE_FAILED" satisfies EnvErrorCode
const options = {
  code: "ENV_SOURCE_FAILED" as const,
  details: { source: "vault:token" },
  message: "Env source failed.",
} satisfies EnvErrorOptions
const error = new EnvError(options)

error.code satisfies "ENV_SOURCE_FAILED"
error.toJSON().details satisfies { source: string } | undefined

new EnvError({ code, message: "Required Env is missing." })

new EnvError({
  code: "INVALID_DETAILS",
  // @ts-expect-error Env error details must be JSON-safe.
  details: { failedAt: new Date() },
  message: "Invalid details.",
})
