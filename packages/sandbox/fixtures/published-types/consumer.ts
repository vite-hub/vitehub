import { NotSupportedError, SandboxError } from "@vite-hub/sandbox"

import type { SandboxErrorCode, SandboxErrorOptions } from "@vite-hub/sandbox"

const code = "SANDBOX_TIMEOUT" satisfies SandboxErrorCode
const options = {
  code: "RENDER_FAILED" as const,
  details: { attempt: 2, provider: "vercel" },
  message: "Render failed.",
} satisfies SandboxErrorOptions
const error = new SandboxError(options)

error.code satisfies "RENDER_FAILED"
error.toJSON().details satisfies { attempt: number; provider: string } | undefined

new SandboxError({ code, message: "Sandbox timed out." })
new NotSupportedError("snapshot", "vercel")

new SandboxError({
  code: "INVALID_DETAILS",
  // @ts-expect-error Sandbox error details must be JSON-safe.
  details: { failedAt: new Date() },
  message: "Invalid details.",
})
