import {
  AuthenticationRequiredError,
  type AuthenticationRequiredErrorOptions,
} from "@vite-hub/auth/agent"
import {
  AuthenticationProviderError,
  type AuthenticationProviderErrorOptions,
} from "@vite-hub/auth/server"

import type { ViteHubErrorShape } from "@vite-hub/runtime"

const options = {
  cause: new Error("protected diagnostic"),
  message: "Sign in required.",
} satisfies AuthenticationRequiredErrorOptions

const error = new AuthenticationRequiredError(options)
error.code satisfies "AUTHENTICATION_REQUIRED"
error.statusCode satisfies 401
error.toJSON() satisfies ViteHubErrorShape<"AUTHENTICATION_REQUIRED">

new AuthenticationRequiredError("Sign in required.")
// @ts-expect-error AuthenticationRequiredError has no public details channel.
new AuthenticationRequiredError({ details: { surface: "agent-invoker" } })

const providerOptions = {
  cause: new Error("protected provider diagnostic"),
  operation: "get-session",
} satisfies AuthenticationProviderErrorOptions
const providerError = new AuthenticationProviderError(providerOptions)
providerError.code satisfies "AUTH_PROVIDER_OPERATION_FAILED"
providerError.details!.operation satisfies "get-auth-for-request" | "get-session"
providerError.details!.provider satisfies "better-auth"
providerError.toJSON() satisfies ViteHubErrorShape<"AUTH_PROVIDER_OPERATION_FAILED">

// @ts-expect-error Provider operations use the closed Auth vocabulary.
new AuthenticationProviderError({ operation: "refresh-session" })
