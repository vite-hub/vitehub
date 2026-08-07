import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"
import { createAuthClient, useSession, useUserSession } from "@vite-hub/auth/vue"

const required = new ViteHubError("AUTHENTICATION_REQUIRED", "Sign in required.")
required.toJSON() satisfies ViteHubErrorShape<"AUTHENTICATION_REQUIRED">

const provider = new ViteHubError<"AUTH_PROVIDER_OPERATION_FAILED", { operation: "get-session", provider: "better-auth" }>(
  "AUTH_PROVIDER_OPERATION_FAILED",
  "Authentication provider operation failed.",
  { details: { operation: "get-session", provider: "better-auth" } },
)
provider.toJSON() satisfies ViteHubErrorShape<"AUTH_PROVIDER_OPERATION_FAILED", { operation: "get-session", provider: "better-auth" }>

const customClient = createAuthClient({ basePath: "/auth" })
customClient.useSession().value.data?.user.id satisfies string | undefined
useSession(customClient).value.data?.user.id satisfies string | undefined
useSession().value.data?.user.id satisfies string | undefined
useUserSession(customClient).loggedIn.value satisfies boolean
