import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"

const required = new ViteHubError("AUTHENTICATION_REQUIRED", "Sign in required.")
required.toJSON() satisfies ViteHubErrorShape<"AUTHENTICATION_REQUIRED">

const provider = new ViteHubError<"AUTH_PROVIDER_OPERATION_FAILED", { operation: "get-session", provider: "better-auth" }>(
  "AUTH_PROVIDER_OPERATION_FAILED",
  "Authentication provider operation failed.",
  { details: { operation: "get-session", provider: "better-auth" } },
)
provider.toJSON() satisfies ViteHubErrorShape<"AUTH_PROVIDER_OPERATION_FAILED", { operation: "get-session", provider: "better-auth" }>
