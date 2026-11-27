import { expect, it } from "vitest"

import { webContainerErrorDiagnostics } from "../src/error-diagnostics.ts"
import { webContainerVitePlugin } from "../src/vite.ts"

it("gives each WebContainer code a fix and its own docs page", () => {
  for (const [code, create] of Object.entries(webContainerErrorDiagnostics)) {
    const error = (create as (params: { route: string }) => Error & { docs?: string, fix?: string })({ route: "playground" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/web-container/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports webContainer without routes with its code and fix", () => {
  expect(() => webContainerVitePlugin({ routes: [] })).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_ROUTES_MISSING",
    fix: expect.stringContaining("webContainer: { routes: [\"/playground/**\"] }"),
  }))
})

it("reports a webContainer route without a leading slash with its code and fix", () => {
  expect(() => webContainerVitePlugin({ routes: ["playground/**"] })).toThrow(expect.objectContaining({
    code: "WEB_CONTAINER_ROUTE_INVALID",
    fix: expect.stringContaining("`/`"),
    message: "`webContainer` route \"playground/**\" must start with \"/\".",
  }))
})
