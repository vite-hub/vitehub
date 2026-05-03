import { describe, expect, it } from "vitest"

import { envSource, envVariable } from "../src/index.ts"
import { validateEnvConfigShape } from "../src/core/resolve.ts"

import { stringSchema } from "./helpers.ts"

describe("env declarations", () => {
  it("creates env variable shorthand declarations", () => {
    expect(envVariable("DATABASE_URL", {
      schema: stringSchema(),
      secret: true,
    })).toMatchObject({
      kind: "env-variable",
      mode: "runtime",
      secret: true,
      source: {
        kind: "env",
        label: "env:DATABASE_URL",
        name: "DATABASE_URL",
      },
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

  it("rejects runtime declarations in Vite config", () => {
    expect(() => validateEnvConfigShape({
      server: {
        databaseUrl: envVariable("DATABASE_URL", { schema: stringSchema() }),
      },
    }, "vite")).toThrow("`env.server` is not available")
  })

  it("rejects custom runtime sources in Nitro config", () => {
    expect(() => validateEnvConfigShape({
      server: {
        commit: envVariable({
          mode: "runtime",
          schema: stringSchema(),
          source: envSource.gitCommit(),
        }),
      },
    }, "nitro")).toThrow("build-only")
  })
})
