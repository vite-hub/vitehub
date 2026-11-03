import { nuxtSafeRuntimeConfig } from "./nuxt-safe-runtime-config/index.ts"

import type { Codemod } from "./types.ts"

/** Every available codemod. Add a new codemod here to make the CLI list and run it. */
export const codemods: readonly Codemod[] = [
  nuxtSafeRuntimeConfig,
]
