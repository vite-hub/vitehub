import { describe, expect, it } from "vitest"

import { envSource, envVariable } from "../src/index.ts"
import { validateEnvConfigShape } from "../src/core/resolve.ts"

describe("env declarations", () => {
  it("defaults env variable shorthand declarations to required runtime strings", () => {
    expect(envVariable("DATABASE_URL")).toMatchObject({
      kind: "env-variable",
      mode: "runtime",
      required: true,
      secret: false,
      source: {
        kind: "env",
        label: "env:DATABASE_URL",
        name: "DATABASE_URL",
      },
    })
  })

  it("supports optional and secret env variable options", () => {
    expect(envVariable("DATABASE_URL", {
      optional: true,
      secret: true,
    })).toMatchObject({
      required: false,
      secret: true,
      source: {
        kind: "env",
        label: "env:DATABASE_URL",
        name: "DATABASE_URL",
      },
    })
  })

  it("rejects conflicting optional and required options", () => {
    expect(() => envVariable("DATABASE_URL", {
      optional: true,
      required: true,
    })).toThrow("cannot use both optional and required")
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
      databaseUrl: envVariable("DATABASE_URL"),
    }, "vite")).toThrow("Invalid declaration")
  })

  it("rejects nested Nitro server and public buckets", () => {
    expect(() => validateEnvConfigShape({
      server: envVariable("DATABASE_URL"),
    }, "nitro")).toThrow("`env.server` is not available")
    expect(() => validateEnvConfigShape({
      public: envVariable("PUBLIC_API_BASE"),
    }, "nitro")).toThrow("`env.public` is not available")
  })

  it("rejects custom runtime sources in Nitro config", () => {
    expect(() => validateEnvConfigShape({
      commit: envVariable({
        mode: "runtime",
        source: envSource.gitCommit(),
      }),
    }, "nitro")).toThrow("build-only")
  })
})
