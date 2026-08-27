import { describe, expectTypeOf, it } from "vitest"
import type { Plugin, UserConfig } from "vite"

import {
  defineEnvProvider,
  env,
  loadServerEnv,
  SecretEnv,
  type EnvConfigOptions,
  type EnvProvider,
  type EnvVariableDeclaration,
  type ServerEnvInspection,
} from "../src/index.ts"
import { hubEnv } from "../src/vite.ts"

describe("types", () => {
  it("types Vite integration and declarations", () => {
    expectTypeOf(hubEnv()).toMatchTypeOf<Plugin>()
    expectTypeOf(env.gitCommit({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env.gitRef().label).toMatchTypeOf<string>()
    expectTypeOf(env.gitSha({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env.gitTag().label).toMatchTypeOf<string>()
    expectTypeOf(env.buildTimestamp().label).toMatchTypeOf<string>()
    expectTypeOf(env.provider("secrets", "token")).toMatchTypeOf<ReturnType<typeof env.provider>>()
    expectTypeOf(env({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.variable({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(new SecretEnv("secret").unseal()).toEqualTypeOf<string>()
    // @ts-expect-error string shorthands were intentionally removed
    env("SECRET")

    const provider = defineEnvProvider({
      async read({ env: localEnv, keys, signal }) {
        expectTypeOf(localEnv).toMatchTypeOf<Readonly<Record<string, unknown>>>()
        expectTypeOf(keys).toMatchTypeOf<readonly string[]>()
        expectTypeOf(signal).toMatchTypeOf<AbortSignal | undefined>()
        return Object.fromEntries(keys.map(key => [key, "value"]))
      },
    })
    expectTypeOf(provider).toMatchTypeOf<EnvProvider>()
    defineEnvProvider<{ bootstrap: { regions: string[] } }>({
      async read({ env: localEnv }) {
        // @ts-expect-error provider bootstrap snapshots are recursively readonly
        localEnv.bootstrap.regions.push("eu-west")
        return {}
      },
    })
    const loaded = loadServerEnv<{ nested: { values: string[] } }>({}, undefined, { providers: { secrets: provider } })
    expectTypeOf(loaded).toMatchTypeOf<Promise<{ readonly nested: { readonly values: readonly string[] } }>>()
    void loaded.then((snapshot) => {
      // @ts-expect-error loaded snapshots are recursively readonly
      snapshot.nested.values[0] = "changed"
    })
    // @ts-expect-error provider reads must return a record of requested values
    defineEnvProvider({ read: async () => "token" })
    // @ts-expect-error provider values must be strings or undefined
    defineEnvProvider({ read: async () => ({ token: { nested: "secret" } }) })
    expectTypeOf<ServerEnvInspection["entries"]>().toMatchTypeOf<readonly unknown[]>()
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
          codexAuth: env({ secret: true, source: env.provider("secrets", "codex/auth.json") }),
          nested: {
            appType: "SingleTenant",
          },
        },
      },
    }

    expectTypeOf(config.env).toMatchTypeOf<EnvConfigOptions | undefined>()
    expectTypeOf(hubEnv({ providers: { secrets: "./server/env/secrets.ts" } })).toMatchTypeOf<Plugin>()
  })
})
