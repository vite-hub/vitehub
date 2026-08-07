import { useServerEnv } from "#vitehub/env/server"
import { setAuthRuntimeEnvResolver } from "@vite-hub/auth/server"

export default function viteHubAuthNuxtRuntime(): void {
  setAuthRuntimeEnvResolver(useServerEnv)
}
