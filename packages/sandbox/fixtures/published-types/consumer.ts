import { NotSupportedError, SandboxError } from "@vite-hub/sandbox/errors"

import type {
  SandboxErrorCode,
  SandboxErrorDetails,
  SandboxErrorJSON,
  SandboxErrorOptions,
} from "@vite-hub/sandbox/errors"

const code = "SANDBOX_TIMEOUT" satisfies SandboxErrorCode
const options = {
  code,
  details: { provider: "vercel", timeoutMs: 1_000 },
  message: "Private provider diagnostic.",
} satisfies SandboxErrorOptions
const error = new SandboxError(options)

error.code satisfies SandboxErrorCode
error.details satisfies SandboxErrorDetails | undefined
error.toJSON() satisfies SandboxErrorJSON

new SandboxError({ code, message: "Private timeout diagnostic." })
new NotSupportedError("snapshot", "vercel")

new SandboxError({
  // @ts-expect-error Sandbox owns the complete public error code vocabulary.
  code: "CUSTOM_SANDBOX_ERROR",
  message: "Custom error.",
})

new SandboxError({
  code: "SANDBOX_RUNTIME_ERROR",
  // @ts-expect-error Sandbox error details must be JSON-safe.
  details: { failedAt: new Date() },
  message: "Invalid details.",
})
