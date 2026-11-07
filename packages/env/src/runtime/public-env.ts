// The package resolves `#vitehub/env/public` to this module when the Env Vite plugin does not generate it, such as in
// Node outside Vite. Its declarations type the generated module through the `PublicEnv` interface.
import { envErrorDiagnostics } from "../error-diagnostics.ts"

import type { PublicEnv } from "../types.ts"

/** Reads the declared Public Env. Its values are fixed when the app builds. */
export function usePublicEnv(): PublicEnv {
  throw envErrorDiagnostics.ENV_NOT_GENERATED({ accessor: "usePublicEnv" })
}
