import { defineAuth } from "../src/definition.ts"

import type { AuthResolvedDefinitionOptions } from "../src/types.ts"

/**
 * A Definition callback that returns the same object on each call. Tests use it for runtime-only options such as
 * `secret` and adapters, and requests still share one Better Auth instance because the options keep their identity.
 */
export function defineFixedAuth<const TOptions extends AuthResolvedDefinitionOptions>(options: TOptions) {
  return defineAuth(() => options)
}
