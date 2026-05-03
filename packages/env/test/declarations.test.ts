import { describe, expect, it } from "vitest"

import { envSource, envVariable } from "../src/index.ts"
import { createRuntimeRegistry, resolveEnvSource, validateEnvConfigShape } from "../src/core/resolve.ts"
import { parseSchema } from "../src/schema.ts"

describe("env declarations", () => {
  it("defaults env variable declarations to required runtime strings", () => {
    expect(envVariable()).toMatchObject({
      kind: "env-variable",
      mode: "runtime",
      required: true,
      secret: false,
    })
  })

  it("supports optional and secret env variable options", () => {
    expect(envVariable({
      optional: true,
      secret: true,
    })).toMatchObject({
      required: false,
      secret: true,
    })
  })

  it("rejects conflicting optional and required options", () => {
    expect(() => envVariable({
      optional: true,
      required: true,
    })).toThrow("cannot use both optional and required")
  })

  it("rejects legacy string arguments", () => {
    expect(() => envVariable("DATABASE_URL" as never)).toThrow("single options object")
  })

  it("infers env sources from config paths and prefixes", () => {
    expect(resolveEnvSource(envVariable(), "env.telegram.botToken")).toMatchObject({
      kind: "env",
      label: "env:TELEGRAM_BOT_TOKEN",
      name: "TELEGRAM_BOT_TOKEN",
    })
    expect(resolveEnvSource(envVariable(), "env.define.__APP_VERSION__", "VITEHUB_")).toMatchObject({
      kind: "env",
      label: "env:VITEHUB_DEFINE_APP_VERSION",
      name: "VITEHUB_DEFINE_APP_VERSION",
    })
  })

  it("keeps explicit env source overrides", () => {
    expect(resolveEnvSource(envVariable({ source: envSource.env("CUSTOM_NAME") }), "env.telegram.botToken")).toMatchObject({
      kind: "env",
      label: "env:CUSTOM_NAME",
      name: "CUSTOM_NAME",
    })
  })

  it("creates built-in and custom sources", () => {
    expect(envSource.packageJson("version")).toMatchObject({
      kind: "package-json",
      label: "package.json:version",
      path: "version",
    })
    expect(envSource.gitBranch()).toMatchObject({
      kind: "git-branch",
      label: "git:branch",
    })
    expect(envSource.gitCommit({ short: true })).toMatchObject({
      kind: "git-commit",
      label: "git:commit",
      short: true,
    })
    expect(envSource.custom("custom:preview", () => true)).toMatchObject({
      kind: "custom",
      label: "custom:preview",
      serializable: false,
    })
  })

  it("rejects flat runtime declarations in Vite config", () => {
    expect(() => validateEnvConfigShape({
      databaseUrl: envVariable(),
    }, "vite")).toThrow("Invalid declaration")
  })

  it("rejects nested Nitro server and public buckets", () => {
    expect(() => validateEnvConfigShape({
      server: envVariable(),
    }, "nitro")).toThrow("`env.server` is not available")
    expect(() => validateEnvConfigShape({
      public: envVariable(),
    }, "nitro")).toThrow("`env.public` is not available")
  })

  it("accepts nested Nitro runtime declaration groups", () => {
    expect(() => validateEnvConfigShape({
      telegram: {
        botToken: envVariable({ secret: true }),
      },
      vertex: {
        model: envVariable({ default: "gemini-3.1-pro-preview-customtools" }),
      },
    }, "nitro")).not.toThrow()
  })

  it("creates a runtime registry with inferred nested env sources", () => {
    expect(createRuntimeRegistry({
      telegram: {
        botToken: envVariable({ secret: true }),
      },
    }, { prefix: "VITEHUB_" })).toMatchObject({
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

  it("rejects non-string Nitro runtime types", () => {
    expect(() => createRuntimeRegistry({
      sentryDebug: envVariable({ type: "boolean" }),
    })).toThrow("Nitro runtime values are strings")
  })

  it("rejects custom runtime sources in Nitro config", () => {
    expect(() => validateEnvConfigShape({
      commit: envVariable({
        mode: "runtime",
        source: envSource.gitCommit(),
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
