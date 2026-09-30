import { describe, expect, it } from "vitest"

import { env } from "../src/index.ts"
import { defaultStringSchema } from "../src/core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveEnvSource, validateEnvConfigShape } from "../src/core/resolve.ts"
import { parseSchema } from "../src/schema.ts"

describe("env declarations", () => {
  it("defaults env variable declarations to required runtime strings", () => {
    expect(env()).toMatchObject({
      kind: "env-variable",
      mode: "runtime",
      required: true,
      secret: false,
    })
  })

  it("supports optional and secret env variable options", () => {
    expect(env({
      optional: true,
      secret: true,
    })).toMatchObject({
      required: false,
      secret: true,
    })
  })

  it("validates JavaScript options before reading them", () => {
    expect(() => env(null as never)).toThrow("env() only accepts a single options object.")
    expect(() => env.boolean(null as never)).toThrow("env() only accepts a single options object.")
    const { proxy, revoke } = Proxy.revocable(() => undefined, {})
    revoke()
    expect(() => env(proxy as never)).toThrow("env() only accepts a single options object.")
    expect(() => env.number(proxy as never)).toThrow("env() only accepts a single options object.")
  })

  it("reports the declaration diagnostic when any option read throws", () => {
    for (const property of ["optional", "required", "schema", "default", "source", "mode", "secret", "type"]) {
      const options = new Proxy({}, {
        ownKeys: () => [],
        get: (_, key) => {
          if (key === property) throw new Error("boom")
          return undefined
        },
      })
      for (const declare of [() => env(options), () => env.boolean(options), () => env.number(options), () => env.enum(["draft"], options)]) {
        expect(declare).toThrow("env() only accepts a single options object.")
      }
    }
  })

  it("rejects revoked Proxy schemas as invalid declarations", () => {
    const { proxy, revoke } = Proxy.revocable(() => undefined, {})
    revoke()
    expect(() => createRuntimeRegistry({ appName: { ...env(), schema: proxy } })).toThrow("[vitehub] Env declaration is invalid.")
    expect(() => createRuntimeRegistry({ appName: env({ schema: proxy }) })).toThrow("[vitehub] Env declaration is invalid.")
  })

  it("rejects conflicting optional and required options", () => {
    expect(() => env({
      optional: true,
      required: true,
    })).toThrow("cannot use both optional and required")
  })

  it("infers env sources from config paths and prefixes", () => {
    expect(resolveEnvSource(env(), "env.telegram.botToken")).toMatchObject({
      kind: "env",
      label: "env:TELEGRAM_BOT_TOKEN",
      name: "TELEGRAM_BOT_TOKEN",
    })
    expect(resolveEnvSource(env(), "env.define.__APP_VERSION__", "VITEHUB_")).toMatchObject({
      kind: "env",
      label: "env:VITEHUB_DEFINE_APP_VERSION",
      name: "VITEHUB_DEFINE_APP_VERSION",
    })
  })

  it("keeps explicit env source overrides", () => {
    expect(resolveEnvSource(env({ source: env.source("CUSTOM_NAME") }), "env.telegram.botToken")).toMatchObject({
      kind: "env",
      label: "env:CUSTOM_NAME",
      name: "CUSTOM_NAME",
    })
  })

  it("supports ordered env source aliases", () => {
    expect(resolveEnvSource(env({ source: env.source(["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"]) }), "env.openWorkflow.postgresUrl")).toMatchObject({
      kind: "env",
      label: "env:OPENWORKFLOW_POSTGRES_URL|DATABASE_URL",
      name: "OPENWORKFLOW_POSTGRES_URL",
      names: ["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"],
    })
    expect(() => env.source([])).toThrow("one or more non-empty")
  })

  it("creates serializable runtime provider sources", () => {
    expect(env.provider("secrets", "codex/auth.json")).toEqual({
      key: "codex/auth.json",
      kind: "provider",
      label: "provider",
      provider: "secrets",
      serializable: true,
    })
    expect(createRuntimeRegistry({
      codexAuth: env({ secret: true, source: env.provider("secrets", "codex/auth.json") }),
    })).toMatchObject({
      codexAuth: {
        secret: true,
        source: { key: "codex/auth.json", kind: "provider", provider: "secrets" },
      },
    })
    expect(() => env.provider("", "key")).toThrow("provider name")
    expect(() => env.provider("__proto__", "key")).toThrow("provider name")
    expect(() => env.provider("secrets", "")).toThrow("provider key")
  })

  it("creates built-in and custom sources", () => {
    expect(env.packageJson("version")).toMatchObject({
      kind: "package-json",
      label: "package.json:version",
      path: "version",
    })
    expect(env.gitBranch()).toMatchObject({
      kind: "git-branch",
      label: "git:branch",
    })
    expect(env.gitCommit({ short: true })).toMatchObject({
      kind: "git-commit",
      label: "git:commit",
      short: true,
    })
    expect(env.gitRef()).toMatchObject({
      kind: "git-ref",
      label: "git:ref",
    })
    expect(env.gitSha({ short: true })).toMatchObject({
      kind: "git-sha",
      label: "git:sha",
      short: true,
    })
    expect(env.gitTag()).toMatchObject({
      kind: "git-tag",
      label: "git:tag",
    })
    expect(env.buildTimestamp()).toMatchObject({
      kind: "build-timestamp",
      label: "build:timestamp",
    })
    expect(env.custom("custom:preview", () => true)).toMatchObject({
      kind: "custom",
      label: "custom:preview",
      serializable: false,
    })
  })

  it("resolves git metadata from build env before git", async () => {
    const explicit = createSourceContext({
      env: {
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_REF_TYPE: "tag",
        GITHUB_SHA: "github-sha",
        GIT_REF_NAME: "main",
        GIT_SHA: "abcdef1234567890",
        GIT_TAG: "v9.9.9",
      },
      mode: "build",
      rootDir: "/missing-git-root",
    })
    expect(await explicit.git.sha()).toBe("abcdef1234567890")
    expect(await explicit.git.sha({ short: true })).toBe("abcdef1")
    expect(await explicit.git.ref()).toBe("main")
    expect(await explicit.git.tag()).toBe("v9.9.9")

    const github = createSourceContext({
      env: {
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_REF_TYPE: "tag",
        GITHUB_SHA: "github-sha",
      },
      mode: "build",
      rootDir: "/missing-git-root",
    })
    expect(await github.git.sha()).toBe("github-sha")
    expect(await github.git.ref()).toBe("v1.2.3")
    expect(await github.git.tag()).toBe("v1.2.3")
  })

  it("rejects flat runtime declarations in Vite config", () => {
    expect(() => validateEnvConfigShape({
      databaseUrl: env(),
    } as never, "vite")).toThrow("[vitehub] Env declaration is invalid.")
  })

  it("creates a runtime registry with inferred nested env sources", () => {
    expect(createRuntimeRegistry({
      teams: {
        appType: "SingleTenant",
      },
      telegram: {
        botToken: env({ secret: true }),
      },
    }, { prefix: "VITEHUB_" })).toMatchObject({
      teams: {
        appType: {
          kind: "literal",
          value: "SingleTenant",
        },
      },
      telegram: {
        botToken: {
          source: {
            label: "env:VITEHUB_TELEGRAM_BOT_TOKEN",
            name: "VITEHUB_TELEGRAM_BOT_TOKEN",
          },
        },
      },
    })
  })

  it("accepts default string schemas after config cloning", () => {
    const declaration = env({ default: "Docs App" })
    const schema = { ...(declaration.schema as Record<string, unknown>) }

    expect(createRuntimeRegistry({
      appName: {
        ...declaration,
        schema,
      },
    })).toMatchObject({
      appName: {
        default: "Docs App",
        schema: { kind: "string" },
      },
    })
  })

  it("rejects forged default string schema markers", () => {
    const marker = defaultStringSchema.__vitehubRuntimeSchema

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: {
          __vitehubRuntimeSchema: marker,
        },
      },
    })).toThrow("[vitehub] Env declaration is invalid.")

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: {
          __vitehubRuntimeSchema: marker,
          safeParse: () => ({ data: 123, success: true }),
        },
      },
    })).toThrow("[vitehub] Env declaration is invalid.")

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: {
          __vitehubRuntimeSchema: marker,
          "~standard": {
            validate: () => ({ value: 123 }),
          },
          safeParse: defaultStringSchema.safeParse,
        },
      },
    })).toThrow("[vitehub] Env declaration is invalid.")

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: Object.assign(Object.create({
          "~standard": {
            validate: () => ({ value: 123 }),
          },
        }), {
          __vitehubRuntimeSchema: marker,
          safeParse: defaultStringSchema.safeParse,
        }),
      },
    })).toThrow("[vitehub] Env declaration is invalid.")

    const accessorSchema = {
      __vitehubRuntimeSchema: marker,
      get safeParse() {
        return defaultStringSchema.safeParse
      },
    }
    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: accessorSchema,
      },
    })).toThrow("[vitehub] Env declaration is invalid.")

    let hasChecks = 0
    const proxySchema = new Proxy({
      __vitehubRuntimeSchema: marker,
      safeParse: defaultStringSchema.safeParse,
    }, {
      get(target, property, receiver) {
        if (property === "~standard") {
          return {
            validate: () => ({ value: 123 }),
          }
        }
        return Reflect.get(target, property, receiver)
      },
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
      has(target, property) {
        if (property === "~standard") {
          hasChecks += 1
          return hasChecks > 1
        }
        return Reflect.has(target, property)
      },
      ownKeys(target) {
        return Reflect.ownKeys(target)
      },
    })
    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: 123 as never }),
        schema: proxySchema,
      },
    })).toThrow("Expected a string")
  })

  it("rejects type labels that differ from the runtime parser", () => {
    expect(() => createRuntimeRegistry({
      sentryDebug: env({ type: "boolean" }),
    })).toThrow("[vitehub] Env declaration is invalid.")
    expect(createRuntimeRegistry({ label: env({ type: "string" }) })).toMatchObject({ label: { schema: { kind: "string" } } })
  })

  it("declares typed runtime values with serializable parsers and typed defaults", () => {
    expect(env.boolean({ default: false })).toMatchObject({ default: false, kind: "env-variable", mode: "runtime", required: true, type: "boolean" })
    expect(env.number({ optional: true })).toMatchObject({ required: false, type: "number" })
    expect(env.enum(["draft", "send"], { default: "draft" })).toMatchObject({ default: "draft", type: "\"draft\" | \"send\"" })

    const registry = createRuntimeRegistry({
      labeller: {
        dryRun: env.boolean({ default: false }),
        minConfidence: env.number({ default: 0.6 }),
        mode: env.enum(["draft", "send"], { default: "send" }),
        retries: env.number({ secret: true, source: env.source("LABELLER_RETRIES") }),
      },
    })
    expect(registry).toMatchObject({
      labeller: {
        dryRun: { default: false, schema: { kind: "boolean" } },
        minConfidence: { default: 0.6, schema: { kind: "number" } },
        mode: { default: "send", schema: { kind: "enum", values: ["draft", "send"] } },
        retries: { schema: { kind: "number" }, secret: true },
      },
    })
    expect(JSON.parse(JSON.stringify(registry))).toEqual(registry)
  })

  it("keeps typed parsers after config cloning", () => {
    const declaration = env.enum(["draft", "send"])
    expect(createRuntimeRegistry({
      mode: { ...declaration, schema: { ...(declaration.schema as Record<string, unknown>) } },
    })).toMatchObject({ mode: { schema: { kind: "enum", values: ["draft", "send"] } } })
    expect(() => createRuntimeRegistry({
      mode: { ...declaration, schema: { ...(declaration.schema as Record<string, unknown>), safeParse: () => ({ data: "x", success: true }) } },
    })).toThrow("[vitehub] Env declaration is invalid.")
  })

  it("rejects invalid typed defaults and enum values", () => {
    expect(() => createRuntimeRegistry({ dryRun: env.boolean({ default: "yes" as never }) })).toThrow("Invalid default for env.dryRun: Expected a boolean default.")
    expect(() => createRuntimeRegistry({ dryRun: env.boolean({ default: "false" as never }) })).toThrow("Expected a boolean default.")
    expect(() => createRuntimeRegistry({ limit: env.number({ default: "0.6" as never }) })).toThrow("Expected a number default.")
    expect(() => createRuntimeRegistry({ limit: env.number({ default: Number.NaN }) })).toThrow("Expected a finite number.")
    expect(() => createRuntimeRegistry({ mode: env.enum(["draft"], { default: "send" as never }) })).toThrow("Expected one of \"draft\".")
    expect(() => env.enum([] as never)).toThrow("unique non-empty strings")
    expect(() => env.enum(["draft", "draft"])).toThrow("unique non-empty strings")
    expect(() => env.enum([""])).toThrow("unique non-empty strings")
  })

  it("parses typed values for build and public declarations", () => {
    expect(parseSchema(env.boolean({ mode: "build" }).schema, " TRUE ", "env.public.debug")).toBe(true)
    expect(parseSchema(env.number({ mode: "build" }).schema, "3000", "env.public.port")).toBe(3000)
    expect(() => parseSchema(env.number({ mode: "build" }).schema, "", "env.public.port")).toThrow("Invalid env.public.port: Expected a finite number.")
  })

  it("rejects build-mode runtime registry declarations", () => {
    expect(() => createRuntimeRegistry({
      appName: env({ mode: "build" }),
    })).toThrow("[vitehub] Env declaration is invalid.")
  })

  it("rejects invalid runtime registry values", () => {
    expect(() => createRuntimeRegistry({
      empty: undefined,
    } as never)).toThrow("[vitehub] Env declaration is invalid.")

    expect(() => createRuntimeRegistry(null as never)).toThrow("[vitehub] Env declaration is invalid.")
  })

  it("rejects custom runtime registry sources", () => {
    expect(() => createRuntimeRegistry({
      commit: env({
        mode: "runtime",
        source: env.gitCommit(),
      }),
    })).toThrow("[vitehub] Env declaration is invalid.")
  })

  it("accepts standard-schema results with empty issues", () => {
    expect(parseSchema({
      "~standard": {
        validate: () => ({ issues: [], value: "ok" }),
      },
    }, "ok", "env.test")).toBe("ok")
  })
})
