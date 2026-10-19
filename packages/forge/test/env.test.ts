import { providersFromEnv } from "forges/env"
import { describe, expect, it } from "vitest"

import { forgeEnv, readForgeEnv } from "../src/index.ts"

function upperSnake(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
}

describe("forgeEnv", () => {
  it("reads the canonical VITEHUB_ name first", () => {
    for (const [forge, fields] of Object.entries(forgeEnv)) {
      for (const [field, spec] of Object.entries(fields)) {
        expect(spec.names[0]).toBe(`VITEHUB_${forge.toUpperCase()}_${upperSnake(field)}`)
      }
    }
  })

  it("falls back only to FORGES_ names", () => {
    for (const fields of Object.values(forgeEnv)) {
      for (const spec of Object.values(fields)) {
        for (const name of spec.names.slice(1)) {
          expect(name).toBe(spec.names[0].replace(/^VITEHUB_/, "FORGES_"))
        }
      }
    }
  })

  it.each([
    ["github", { FORGES_GITHUB_TOKEN: "token" }],
    ["gitlab", { FORGES_GITLAB_TOKEN: "token" }],
    ["forgejo", { FORGES_FORGEJO_TOKEN: "token" }],
  ])("uses FORGES_ names that forges reads for %s", (forge, env) => {
    expect(providersFromEnv(env)).toContainEqual(expect.objectContaining({ forge, factory: expect.any(Object) }))
  })
})

describe("readForgeEnv", () => {
  it("reads the VITEHUB_ name first, then the FORGES_ name", () => {
    expect(readForgeEnv(forgeEnv.github.token, { FORGES_GITHUB_TOKEN: "forges", VITEHUB_GITHUB_TOKEN: "vitehub" })).toBe("vitehub")
    expect(readForgeEnv(forgeEnv.github.token, { FORGES_GITHUB_TOKEN: " forges ", VITEHUB_GITHUB_TOKEN: " " })).toBe("forges")
  })

  it("does not read other names", () => {
    expect(readForgeEnv(forgeEnv.github.token, { GH_TOKEN: "gh", GITHUB_TOKEN: "github" })).toBeUndefined()
  })

  it("reads through a lookup function and skips values that are not strings", () => {
    const bindings: Record<string, unknown> = { FORGES_GITHUB_TOKEN: "binding", VITEHUB_GITHUB_TOKEN: 1 }
    expect(readForgeEnv(forgeEnv.github.token, name => bindings[name])).toBe("binding")
  })
})
