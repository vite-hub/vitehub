import { describe, expect, it } from "vitest"

import { forgeEnv, forgeErrorStatus, forgeImportError, readForgeEnv } from "../src/forge.ts"

function missing(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {})
}

describe("forgeImportError()", () => {
  it.each([
    ["Node", missing("Cannot find package '@vite-hub/forge' imported from /app/.output/server/index.mjs", "ERR_MODULE_NOT_FOUND")],
    ["workerd", missing("No such module \"@vite-hub/forge\".")],
    ["a Vite build", missing("Could not resolve \"@vite-hub/forge\" imported by \"@vite-hub/workspace\". Is it installed?")],
  ])("names the install command when %s cannot find the package", (_host, error) => {
    expect(forgeImportError(error, "A GitHub Workspace")).toMatchObject({
      code: "INTERNAL_FORGE_NOT_INSTALLED",
      message: expect.stringContaining("A GitHub Workspace needs @vite-hub/forge"),
      cause: error,
    })
  })

  it("keeps other load errors", () => {
    const error = missing("Cannot find package 'forges' imported from /app/node_modules/@vite-hub/forge/dist/index.js", "ERR_MODULE_NOT_FOUND")
    expect(forgeImportError(error, "A GitHub Source")).toBe(error)
  })
})

it("reads the Forge env names and the status of a Forge error", () => {
  expect(readForgeEnv(forgeEnv.github.token, { FORGES_GITHUB_TOKEN: " ghp_x " })).toBe("ghp_x")
  expect(forgeErrorStatus(Object.assign(new Error("Not Found"), { status: 404 }))).toBe(404)
  expect(forgeErrorStatus(new Error("no status"))).toBeUndefined()
})
