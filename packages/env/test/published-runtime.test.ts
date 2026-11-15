import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const env = await import(distEntry.href)

describe("published Env runtime", () => {
  it("does not publish a package-specific error constructor", () => {
    expect(env).not.toHaveProperty("EnvError")
  })

  it("keeps explicit registries separate from generated app accessors", async () => {
    const server = await import("@vite-hub/env/server")
    expect(server.resolveServerEnv({})).toEqual({})
    await expect(server.loadServerEnv({})).resolves.toEqual({})
    expect(() => env.useServerEnv()).toThrow(expect.objectContaining({ code: "ENV_NOT_GENERATED" }))
  })
})
