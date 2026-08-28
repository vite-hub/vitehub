declare module "#vitehub/env/public" {
  export interface PublicEnv extends Record<string, unknown> {}
  export const publicEnv: PublicEnv
  export function usePublicEnv(): PublicEnv
}

declare module "#vitehub/env/server" {
  export interface ServerEnv extends Record<string, unknown> {}
  export interface ServerEnvInspectionEntry {
    masked: boolean
    path?: string
    source: "env" | "literal" | "provider"
    status: "available" | "defaulted" | "error" | "invalid" | "missing"
  }
  export interface ServerEnvInspection {
    entries: readonly ServerEnvInspectionEntry[]
  }
  export type ReadonlyServerEnv = DeepReadonly<ServerEnv>
  type DeepReadonly<T> = T extends SecretEnv<unknown>
    ? T
    : T extends (...args: infer TArguments) => infer TResult
    ? (...args: TArguments) => TResult
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T
  export function inspectServerEnv(event?: unknown, options?: { signal?: AbortSignal }): Promise<ServerEnvInspection>
  export function loadServerEnv(event?: unknown, options?: { signal?: AbortSignal }): Promise<ReadonlyServerEnv>
  export function useServerEnv(event?: unknown): ServerEnv
  export function runWithServerEnv<T>(event: unknown, callback: (env: ReadonlyServerEnv) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
}
