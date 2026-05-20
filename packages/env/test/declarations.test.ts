import { describe, expect, it } from "vitest"

import { env } from "../src/index.ts"
import { defaultStringSchema } from "../src/core/declarations.ts"
import { createRuntimeRegistry, resolveEnvSource, validateEnvConfigShape } from "../src/core/resolve.ts"
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

  it("rejects conflicting optional and required options", () => {
    expect(() => env({
      optional: true,
      required: true,
    })).toThrow("cannot use both optional and required")
  })

  it("rejects legacy string arguments", () => {
    expect(() => env("DATABASE_URL" as never)).toThrow("single options object")
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
    expect(env.custom("custom:preview", () => true)).toMatchObject({
      kind: "custom",
      label: "custom:preview",
      serializable: false,
    })
  })

  it("rejects flat runtime declarations in Vite config", () => {
    expect(() => validateEnvConfigShape({
      databaseUrl: env(),
    }, "vite")).toThrow("Invalid declaration")
  })

  it("rejects nested Nitro server buckets", () => {
    expect(() => validateEnvConfigShape({
      server: env(),
    }, "nitro")).toThrow("`env.server` is not available")
  })

  it("rejects scalar Nitro public runtime declarations", () => {
    expect(() => validateEnvConfigShape({
      public: env(),
    }, "nitro")).toThrow("Invalid declaration at env.public")
  })

  it("accepts nested Nitro runtime declaration groups and public runtime transport", () => {
    expect(() => validateEnvConfigShape({
      public: {
        apiBase: env(),
      },
      teams: {
        appId: env({ secret: true }),
        appType: "SingleTenant",
      },
      telegram: {
        botToken: env({ secret: true }),
      },
      vertex: {
        model: env({ default: "gemini-3.1-pro-preview-customtools" }),
      },
    }, "nitro")).not.toThrow()
  })

  it("rejects unsupported Nitro runtime values", () => {
    expect(() => validateEnvConfigShape({
      teams: {
        appType: () => "SingleTenant",
      },
    } as never, "nitro")).toThrow("serializable literal")
    expect(() => validateEnvConfigShape({
      teams: {
        createdAt: new Date(),
      },
    } as never, "nitro")).toThrow("serializable literal")
  })

  it("rejects Nitro runtime literals that JSON cannot preserve", () => {
    expect(() => validateEnvConfigShape({
      teams: {
        retryDelay: Number.NaN,
      },
    }, "nitro")).toThrow("serializable literal")
    expect(() => validateEnvConfigShape({
      teams: {
        retryDelay: Number.POSITIVE_INFINITY,
      },
    }, "nitro")).toThrow("serializable literal")
    expect(() => validateEnvConfigShape({
      teams: {
        labels: [undefined, "primary"],
      },
    } as never, "nitro")).toThrow("serializable literal")
  })

  it("rejects secret Nitro public Runtime Env declarations", () => {
    expect(() => validateEnvConfigShape({
      public: {
        apiBase: env({ secret: true }),
      },
    }, "nitro")).toThrow("env.public.apiBase cannot be marked secret")
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
    const marker = defaultStringSchema.__vitehubDefaultRuntimeSchema

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: {
          __vitehubDefaultRuntimeSchema: marker,
        },
      },
    })).toThrow("custom schema")

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: {
          __vitehubDefaultRuntimeSchema: marker,
          safeParse: () => ({ data: 123, success: true }),
        },
      },
    })).toThrow("custom schema")

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: {
          __vitehubDefaultRuntimeSchema: marker,
          "~standard": {
            validate: () => ({ value: 123 }),
          },
          safeParse: defaultStringSchema.safeParse,
        },
      },
    })).toThrow("custom schema")

    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: Object.assign(Object.create({
          "~standard": {
            validate: () => ({ value: 123 }),
          },
        }), {
          __vitehubDefaultRuntimeSchema: marker,
          safeParse: defaultStringSchema.safeParse,
        }),
      },
    })).toThrow("custom schema")

    const accessorSchema = {
      __vitehubDefaultRuntimeSchema: marker,
      get safeParse() {
        return defaultStringSchema.safeParse
      },
    }
    expect(() => createRuntimeRegistry({
      appName: {
        ...env({ default: "Docs App" }),
        schema: accessorSchema,
      },
    })).toThrow("custom schema")

    let hasChecks = 0
    const proxySchema = new Proxy({
      __vitehubDefaultRuntimeSchema: marker,
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
    })).toThrow("Expected string")
  })

  it("rejects non-string Nitro runtime types", () => {
    expect(() => createRuntimeRegistry({
      sentryDebug: env({ type: "boolean" }),
    })).toThrow("Nitro runtime values are strings")
  })

  it("rejects custom runtime sources in Nitro config", () => {
    expect(() => validateEnvConfigShape({
      commit: env({
        mode: "runtime",
        source: env.gitCommit(),
      }),
    }, "nitro")).toThrow("build-only")
  })

  it("accepts standard-schema results with empty issues", () => {
    expect(parseSchema({
      "~standard": {
        validate: () => ({ issues: [], value: "ok" }),
      },
    }, "ok", "env.test")).toBe("ok")
  })
})
