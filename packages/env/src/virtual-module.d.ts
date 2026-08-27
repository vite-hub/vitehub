import type { SecretEnv } from "./secret"

declare module "#vitehub/env/public" {
  export interface PublicEnv extends Record<string, unknown> {}
  export const publicEnv: PublicEnv
  export function usePublicEnv(): PublicEnv
}

declare module "#vitehub/env/server" {
  export interface ServerEnv extends Record<string, unknown> {}
  export function useServerEnv(event?: unknown): ServerEnv
  export function runWithServerEnv<T>(event: unknown, callback: (env: ServerEnv) => T | Promise<T>): Promise<T>
}

export {}
