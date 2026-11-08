import { nuxtSafeRuntimeConfig } from "./nuxt-safe-runtime-config/index.ts"
import { nuxthub } from "./nuxthub/index.ts"
import { t3Env } from "./t3-env/index.ts"

import type { Codemod } from "./types.ts"

/**
 * Every available codemod. Add a new codemod here to make the CLI list and run it. NuxtHub runs first: it renames
 * hub to vitehub in place and picks the preset from the Wrangler config, and the others add to that vitehub key.
 */
export const codemods: readonly Codemod[] = [
  nuxthub,
  nuxtSafeRuntimeConfig,
  t3Env,
]
