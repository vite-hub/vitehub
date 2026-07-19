import {
  AuthSessionError,
  type AuthSessionErrorOptions,
  AuthenticationRequiredError,
  type AuthenticationRequiredErrorOptions,
} from "@vite-hub/auth/agent"

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

const sessionOptions = {
  cause: new Error("protected provider diagnostic"),
} satisfies AuthSessionErrorOptions
const sessionError = new AuthSessionError(sessionOptions)
sessionError.code satisfies "AUTH_SESSION_FAILED"
sessionError.statusCode satisfies 503
sessionError.toJSON() satisfies ViteHubErrorShape<"AUTH_SESSION_FAILED">
