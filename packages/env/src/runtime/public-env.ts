import { envErrorDiagnostics } from "../error-diagnostics.ts"

import type { PublicEnv } from "../types.ts"

/** Reads the declared Public Env. Its values are fixed when the app builds. */
export function usePublicEnv(): PublicEnv {
  throw envErrorDiagnostics.ENV_NOT_GENERATED({ accessor: "usePublicEnv" })
}
