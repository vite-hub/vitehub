import { nuxtSafeRuntimeConfig } from "./nuxt-safe-runtime-config/index.ts"
import { t3Env } from "./t3-env/index.ts"

import type { Codemod } from "./types.ts"

/** Every available codemod. Add a new codemod here to make the CLI list and run it. */
export const codemods: readonly Codemod[] = [
  nuxtSafeRuntimeConfig,
  t3Env,
]
