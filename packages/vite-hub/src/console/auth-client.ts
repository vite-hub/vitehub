import type { createAuthClient } from "@vite-hub/auth/vue"

export interface ConsoleAuthClient {
  plugins?: NonNullable<Parameters<typeof createAuthClient>[0]>["plugins"]
  setup?: (client: ReturnType<typeof createAuthClient>) => void
}

export function defineConsoleAuthClient(config: ConsoleAuthClient): ConsoleAuthClient {
  return config
}
