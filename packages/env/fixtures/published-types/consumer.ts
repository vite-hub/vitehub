import { ViteHubError } from "@vite-hub/runtime"

import type { EnvErrorCode, EnvErrorDetails, EnvSourceIdentifier } from "@vite-hub/env"

const code = "ENV_SOURCE_FAILED" satisfies EnvErrorCode
const source = "git:branch" satisfies EnvSourceIdentifier
const details = { source } satisfies EnvErrorDetails<typeof code>
const error = new ViteHubError<typeof code, typeof details>(code, "Env source resolution failed.", { details })

error.code satisfies EnvErrorCode
error.details satisfies EnvErrorDetails<typeof code> | undefined

// @ts-expect-error Env source details use the bounded public identifier vocabulary.
const invalidSource: EnvSourceIdentifier = "vault:token"
void invalidSource
