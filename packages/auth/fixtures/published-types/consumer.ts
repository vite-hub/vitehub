import {
  AuthenticationProviderError,
  type AuthenticationProviderErrorOptions,
  AuthenticationRequiredError,
  type AuthenticationRequiredErrorOptions,
} from "@vite-hub/auth/agent"

import type { ViteHubErrorShape } from "@vite-hub/runtime"

const options = {
  details: { surface: "agent-invoker" },
  message: "Sign in required.",
} satisfies AuthenticationRequiredErrorOptions

const error = new AuthenticationRequiredError(options)
error.code satisfies "AUTHENTICATION_REQUIRED"
error.statusCode satisfies 401
error.toJSON() satisfies ViteHubErrorShape<"AUTHENTICATION_REQUIRED">

new AuthenticationRequiredError("Sign in required.")

const providerOptions = {
  operation: "get-session",
} satisfies AuthenticationProviderErrorOptions
const providerError = new AuthenticationProviderError(providerOptions)
providerError.code satisfies "AUTH_PROVIDER_OPERATION_FAILED"
providerError.toJSON() satisfies ViteHubErrorShape<"AUTH_PROVIDER_OPERATION_FAILED">
