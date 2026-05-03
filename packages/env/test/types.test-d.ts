import { describe, expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"
import type { NitroModule } from "nitro/types"

import { envSource, envVariable, type EnvVariableDeclaration } from "../src/index.ts"
import { envNitro } from "../src/nitro.ts"
import { envVite } from "../src/vite.ts"

describe("types", () => {
  it("types framework integrations and declarations", () => {
    expectTypeOf(envVite()).toMatchTypeOf<Plugin>()
    expectTypeOf(envNitro()).toMatchTypeOf<NitroModule>()
    expectTypeOf(envSource.gitCommit({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(envVariable("SECRET", { secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
  })
})
