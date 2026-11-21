import * as v from "valibot"
import { describe, expectTypeOf, it } from "vitest"
import type { Result } from "@vite-hub/runtime"
import type { Plugin } from "vite"

import {
  checkServiceToken,
  defineEnvProvider,
  env,
  requireServiceToken,
  SecretEnv,
  type EnvDeclarations,
  type EnvOptions,
  type EnvProvider,
  type EnvVariableDeclaration,
  type ServerEnvInspection,
  type ServiceTokenErrorCode,
  signWebhook,
  verifyWebhook,
  type WebhookErrorCode,
} from "../src/index.ts"
import { loadServerEnv } from "../src/server.ts"
import { hubEnv } from "../src/vite.ts"

describe("types", () => {
  it("types the service token guards", () => {
    const request = new Request("https://example.test/")
    expectTypeOf(checkServiceToken(request, "INGEST_TOKEN")).toEqualTypeOf<Result<void, ServiceTokenErrorCode>>()
    expectTypeOf<ServiceTokenErrorCode>().toEqualTypeOf<"ENV_SERVICE_TOKEN_INVALID" | "ENV_SERVICE_TOKEN_UNSET">()
    expectTypeOf(requireServiceToken(request, "INGEST_TOKEN")).toEqualTypeOf<void>()
  })

  it("types verifyWebhook()", () => {
    const request = new Request("https://example.test/")
    expectTypeOf(verifyWebhook(request, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET", schema: v.object({ type: v.string() }) })).toEqualTypeOf<Promise<Result<{ type: string }, WebhookErrorCode>>>()
    // @ts-expect-error The body is not checked, so the caller cannot name its type. Pass `schema`.
    void verifyWebhook<{ type: string }>(request, { provider: "stripe", secret: "STRIPE_WEBHOOK_SECRET" })
    expectTypeOf(verifyWebhook(request, { provider: "github", secret: "GITHUB_WEBHOOK_SECRET" })).toEqualTypeOf<Promise<Result<unknown, WebhookErrorCode>>>()
    // @ts-expect-error A custom HMAC needs the header that carries the signature.
    void verifyWebhook(request, { provider: "hmac", secret: "LULU_WEBHOOK_SECRET" })
  })

  it("types signWebhook()", () => {
    expectTypeOf(signWebhook("{}", { provider: "github", secret: "s" })).toEqualTypeOf<Promise<Record<string, string>>>()
    // @ts-expect-error Only GitHub and Stripe signatures can be created.
    void signWebhook("{}", { provider: "hmac", secret: "s" })
  })

  it("types Vite integration and declarations", () => {
    expectTypeOf(hubEnv()).toMatchTypeOf<Plugin>()
    expectTypeOf(env.gitCommit({ short: true }).label).toMatchTypeOf<string>()
    expectTypeOf(env.gitBranch().label).toMatchTypeOf<string>()
    // @ts-expect-error env.gitCommit() reads CI variables, then Git
    env.gitSha()
    // @ts-expect-error env.gitBranch() reads CI variables, then Git
    env.gitRef()
    expectTypeOf(env.gitTag().label).toMatchTypeOf<string>()
    expectTypeOf(env.buildTimestamp().label).toMatchTypeOf<string>()
    expectTypeOf(env.provider("secrets", "token")).toMatchTypeOf<ReturnType<typeof env.provider>>()
    expectTypeOf(env({ secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    // @ts-expect-error env() is the only variable declaration
    env.variable({ secret: true })
    expectTypeOf(env({ optional: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env({ optional: false, default: "eu" })).toMatchTypeOf<EnvVariableDeclaration>()
    // @ts-expect-error a value is required by default; use optional: true
    env({ required: false })
    // @ts-expect-error a default makes the value always present
    env({ default: "eu", optional: true })
    // @ts-expect-error a default makes the value always present
    env.number({ default: 1, optional: true })
    // @ts-expect-error a default makes the value always present
    env.enum(["a", "b"], { default: "a", optional: true })
    expectTypeOf(new SecretEnv("secret").unseal()).toEqualTypeOf<string>()
    // @ts-expect-error string shorthands were intentionally removed
    env("SECRET")
    expectTypeOf(env.boolean({ default: false })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.number({ default: 0.6, secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.enum(["draft", "send"], { default: "draft" })).toMatchTypeOf<EnvVariableDeclaration>()
    // @ts-expect-error typed defaults use the parsed type
    env.boolean({ default: "false" })
    // @ts-expect-error typed defaults use the parsed type
    env.number({ default: "0.6" })
    // @ts-expect-error enum defaults must be one of the declared values
    env.enum(["draft", "send"], { default: "archive" })
    // @ts-expect-error typed helpers own their parser
    env.boolean({ schema: {} })
    // @ts-expect-error enum values are public metadata, so an enum cannot be secret
    env.enum(["draft", "send"], { secret: true })
    expectTypeOf(env.list({ default: ["a.example"] })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.list(env.number(), { default: [80], secret: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.json(env.schemaFrom("./server/env.schema.ts", "settings"), { optional: true })).toMatchTypeOf<EnvVariableDeclaration>()
    expectTypeOf(env.json({ default: { enabled: true } })).toMatchTypeOf<EnvVariableDeclaration>()
    // @ts-expect-error a list default is an array
    env.list({ default: "a.example" })
    // @ts-expect-error env.json() owns its parser
    env.json({ schema: {} })

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
    const loaded = loadServerEnv<{ nested: { values: string[] }, token: SecretEnv<string> }>({}, undefined, { providers: { secrets: provider } })
    expectTypeOf(loaded).toMatchTypeOf<Promise<{ readonly nested: { readonly values: readonly string[] }, readonly token: SecretEnv<string> }>>()
    void loaded.then((snapshot) => {
      expectTypeOf(snapshot.token).toEqualTypeOf<SecretEnv<string>>()
      // @ts-expect-error loaded snapshots are recursively readonly
      snapshot.nested.values[0] = "changed"
    })
    // @ts-expect-error provider reads must return a record of requested values
    defineEnvProvider({ read: async () => "token" })
    // @ts-expect-error provider values must be strings or undefined
    defineEnvProvider({ read: async () => ({ token: { nested: "secret" } }) })
    expectTypeOf<ServerEnvInspection["entries"]>().toMatchTypeOf<readonly unknown[]>()
  })

  it("types env declarations in Env options", () => {
    const options: EnvOptions = {
      providers: { secrets: "./server/env/secrets.ts" },
      define: {
        __APP_VERSION__: env({ mode: "build", source: env.gitCommit({ short: true }) }),
        __DEPLOYMENT_INFO__: {
          package: {
            name: env({ mode: "build", source: env.packageJson("name") }),
          },
          git: {
            branch: env({ mode: "build", source: env.gitBranch() }),
            commit: env({ mode: "build", source: env.gitCommit() }),
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
    }

    expectTypeOf(options).toMatchTypeOf<EnvDeclarations>()
    expectTypeOf(hubEnv(options)).toMatchTypeOf<Plugin>()
    expectTypeOf(hubEnv({ providers: { secrets: "./server/env/secrets.ts" } })).toMatchTypeOf<Plugin>()
  })
})
