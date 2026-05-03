import { describe, expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"
import type { NitroModule } from "nitro/types"

import { rc, type RuntimeConfigRuntimeDeclaration } from "../src/index.ts"
import { runtimeConfigNitro } from "../src/nitro.ts"
import { runtimeConfigVite } from "../src/vite.ts"

describe("types", () => {
  it("types framework integrations and declarations", () => {
    expectTypeOf(runtimeConfigVite()).toMatchTypeOf<Plugin>()
    expectTypeOf(runtimeConfigNitro()).toMatchTypeOf<NitroModule>()
    expectTypeOf(rc.cloudflare.binding.d1("DB").type).toMatchTypeOf<string | undefined>()
    expectTypeOf(rc.runtime.secret("SECRET", {})).toMatchTypeOf<RuntimeConfigRuntimeDeclaration>()
  })
})
