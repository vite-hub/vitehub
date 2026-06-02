import { describe, expectTypeOf, it } from "vitest"
import type { Plugin, UserConfig } from "vite"

import { env, SecretEnv, type EnvConfigOptions, type EnvVariableDeclaration } from "../src/index.ts"
import { envVite } from "../src/vite.ts"

describe("types", () => {
  it("types Vite integration and declarations", () => {
    expectTypeOf(envVite()).toMatchTypeOf<Plugin>()
    expectTypeOf(env.gitCommit({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.variable({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(new SecretEnv("secret").unseal()).toEqualTypeOf<string>()
    // @ts-expect-error string shorthands were intentionally removed
    env("SECRET")
  })

  it("types env declarations on Vite user config", () => {
    const config: UserConfig = {
      env: {
        define: {
          __APP_VERSION__: env({ mode: "build", source: env.gitCommit({ short: true }) }),
        },
        public: {
          appName: env({ default: "ViteHub", mode: "build" }),
        },
      },
    }

    expectTypeOf(config.env).toMatchTypeOf<EnvConfigOptions | undefined>()
  })
})
