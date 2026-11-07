import { nuxtSafeRuntimeConfig } from "./nuxt-safe-runtime-config/index.ts"
import { rootAccessors } from "./root-accessors/index.ts"

import type { Codemod } from "./types.ts"

/** Every available codemod. Add a new codemod here to make the CLI list and run it. */
export const codemods: readonly Codemod[] = [
  nuxtSafeRuntimeConfig,
  rootAccessors,
]

/** Codemods that move an app between ViteHub releases. `vitehub migrate` runs them in order. */
export const upgradeCodemods: readonly Codemod[] = [
  rootAccessors,
]
