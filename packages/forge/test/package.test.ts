import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

describe("published Forge package", () => {
  it("loads its entry and every provider without consumer-installed forges", () => {
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict"
      import { registerHooks } from "node:module"
      import { pathToFileURL } from "node:url"

      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "forges" || specifier.startsWith("forges/")) {
            throw new Error("Consumer must not need to install " + specifier)
          }
          return nextResolve(specifier, context)
        },
      })
      const { forgeProvider, NotFoundError } = await import(pathToFileURL(process.argv[1]).href)
      for (const forge of ["github", "gitlab", "forgejo"]) {
        const provider = await forgeProvider({
          forge,
          baseUrl: "https://forge.example.test",
          fetch: async () => new Response("Not Found", { status: 404 }),
        })
        await assert.rejects(provider.repos.get({ owner: "owner", name: "repo" }), NotFoundError)
      }
      console.log("ok")
    `, entry], { encoding: "utf8", timeout: 15_000 })
    expect(output.trim()).toBe("ok")
  })
})
