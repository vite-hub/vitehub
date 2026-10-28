import { describe, expect, it, vi } from "vitest"

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>()
  return {
    ...original,
    createRequire: () => () => {
      throw Object.assign(new Error("Cannot find module 'typescript'"), { code: "MODULE_NOT_FOUND" })
    },
  }
})

describe("loadTypeScript", () => {
  it("names the package to install when the app has no TypeScript", async () => {
    const { loadTypeScript } = await import("../../src/task/internal/typescript.ts")
    expect(() => loadTypeScript()).toThrow(expect.objectContaining({
      code: "SANDBOX_TASK_C0013",
      message: expect.stringContaining("Install `typescript` in the app."),
    }))
  })
})
