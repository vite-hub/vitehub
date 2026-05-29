import { describe, expectTypeOf, it } from "vitest"
import type { Plugin } from "vite"
import type { NitroModule } from "nitro/types"
import { nitro } from "nitro/vite"

import { env, SecretEnv, type EnvVariableDeclaration } from "../src/index.ts"
import { envNitro } from "../src/nitro.ts"
import { envVite } from "../src/vite.ts"

describe("types", () => {
  it("types framework integrations and declarations", () => {
    expectTypeOf(envVite()).toMatchTypeOf<Plugin>()
    expectTypeOf(envNitro()).toMatchTypeOf<NitroModule>()
    expectTypeOf(env.gitCommit({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.variable({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(new SecretEnv("secret").unseal()).toEqualTypeOf<string>()
    // @ts-expect-error string shorthands were intentionally removed
    env("SECRET")
  })

  it("types env declarations on the Nitro Vite plugin config", () => {
    expectTypeOf(nitro({
      env: {
        token: env({
          secret: true,
          source: env.source("TOKEN"),
        }),
      },
      modules: ["@vitehub/env/nitro"],
    })).toMatchTypeOf<Plugin[]>()
  })
})
