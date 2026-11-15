import { expect, it } from "vitest"

import { webContainerErrorDiagnostics } from "../src/error-diagnostics.ts"
import { hubWebContainer } from "../src/vite.ts"

it("gives each WebContainer code a fix and its own docs page", () => {
  for (const [code, create] of Object.entries(webContainerErrorDiagnostics)) {
    const error = (create as (params: { route: string }) => Error & { docs?: string, fix?: string })({ route: "playground" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/web-container/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports hubWebContainer() without routes with its code and fix", () => {
  expect(() => hubWebContainer({ routes: [] })).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_ROUTES_MISSING",
    fix: expect.stringContaining("routes: [\"/playground/**\"]"),
  }))
})

it("reports a hubWebContainer() route without a leading slash with its code and fix", () => {
  expect(() => hubWebContainer({ routes: ["playground/**"] })).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_ROUTE_INVALID",
    fix: expect.stringContaining("`/`"),
    message: "hubWebContainer() route \"playground/**\" must start with \"/\".",
  }))
})
