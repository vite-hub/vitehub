declare module "#vitehub/env/public" {
  export interface PublicEnv extends Record<string, unknown> {}
  export const publicEnv: PublicEnv
  export function usePublicEnv(): PublicEnv
}

declare module "#vitehub/env/server" {
  import type { SecretEnv } from "@vite-hub/env/secret"

  export interface ServerEnv extends Record<string, unknown> {}
  export const serverEnv: ServerEnv
  export function useServerEnv(event?: unknown): ServerEnv
}

export {}
