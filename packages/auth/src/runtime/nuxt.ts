import { useServerEnv } from "#vitehub/env/server"
import definition from "#vitehub/auth/definition"
import { setAuthRuntimeEnvResolver } from "@vite-hub/auth/server"

export default function viteHubAuthNuxtRuntime(): void {
  setAuthRuntimeEnvResolver(useServerEnv, definition)
}
