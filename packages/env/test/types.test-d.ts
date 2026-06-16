import { describe, expectTypeOf, it } from "vitest"
import type { Plugin, UserConfig } from "vite"

import { env, SecretEnv, type EnvConfigOptions, type EnvVariableDeclaration } from "../src/index.ts"
import { hubEnv } from "../src/vite.ts"

describe("types", () => {
  it("types Vite integration and declarations", () => {
    expectTypeOf(hubEnv()).toMatchTypeOf<Plugin>()
    expectTypeOf(env.gitCommit({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env.gitRef().label).toMatchTypeOf<string>()
    expectTypeOf(env.gitSha({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env.gitTag().label).toMatchTypeOf<string>()
    expectTypeOf(env.buildTimestamp().label).toMatchTypeOf<string>()
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
          __DEPLOYMENT_INFO__: {
            package: {
              name: env({ mode: "build", source: env.packageJson("name") }),
            },
            git: {
              ref: env({ mode: "build", source: env.gitRef() }),
              sha: env({ mode: "build", source: env.gitSha() }),
              tag: env({ mode: "build", optional: true, source: env.gitTag() }),
            },
            timestamp: env({ mode: "build", source: env.buildTimestamp() }),
          },
        },
        public: {
          appName: env({ default: "ViteHub", mode: "build" }),
        },
        server: {
          airtableToken: env({ secret: true }),
          nested: {
            appType: "SingleTenant",
          },
        },
      },
    }

    expectTypeOf(config.env).toMatchTypeOf<EnvConfigOptions | undefined>()
  })
})
