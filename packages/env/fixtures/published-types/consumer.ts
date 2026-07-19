import { EnvError } from "@vite-hub/env"

import type {
  EnvErrorCode,
  EnvErrorDetails,
  EnvErrorOptions,
  EnvSourceIdentifier,
} from "@vite-hub/env"

const code = "ENV_REQUIRED_MISSING" satisfies EnvErrorCode
const source = "git:branch" satisfies EnvSourceIdentifier
const details = { source } satisfies EnvErrorDetails<"ENV_SOURCE_FAILED">
const options = {
  cause: new Error("protected diagnostic"),
  code: "ENV_SOURCE_FAILED" as const,
  details,
} satisfies EnvErrorOptions<"ENV_SOURCE_FAILED">
const error = new EnvError(options)

error.code satisfies "ENV_SOURCE_FAILED"
error.toJSON().details satisfies { source?: EnvSourceIdentifier } | undefined

new EnvError({ code })

new EnvError({
  // @ts-expect-error Env errors use the closed ViteHub code vocabulary.
  code: "ENV_CUSTOM_FAILED",
})

new EnvError({
  code: "ENV_SOURCE_FAILED",
  details: {
    // @ts-expect-error Env source details use the bounded public identifier vocabulary.
    source: "vault:token",
  },
})

new EnvError({
  code,
  // @ts-expect-error Env error messages are fixed by code.
  message: "Required Env is missing.",
})
