import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { H3, HTTPError, type H3Config } from "h3"
import { expect, it } from "vitest"

import "./support/console-access.ts"
import { consoleHttpError } from "../src/console/runtime/server/http-error.ts"
import { consoleRequestError } from "../src/console/runtime/server/request.ts"
import usageRoute from "../src/console/runtime/server/usage.get.ts"
import { failure } from "../src/console/runtime/server/workspace-history.ts"
import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"

// H3 2 marks a thrown error that is not its `HTTPError` as unhandled, and Nitro's error handler then answers 500.
const nitroRoot = dirname(createRequire(import.meta.url).resolve("nitro/package.json"))
const { default: onError }: { default: NonNullable<H3Config["onError"]> } = await import(pathToFileURL(join(nitroRoot, "dist/runtime/internal/error/prod.mjs")).href)
const app = new H3({ onError })
  .get("/_vitehub/api/usage", usageRoute)
  .get("/denied", () => {
    throw consoleRequestError(403, "This Console access does not include this section.")
  })
  .get("/diagnostic", () => {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0071({ message: "Invalid usage window" }))
  })
  .get("/workspace", () => {
    throw failure(404, "This Workspace has no retained history.")
  })

async function call(path: string, init?: RequestInit) {
  const response = await app.fetch(new Request(`http://localhost${path}`, init))
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

it("answers a Console request error with its status and diagnostic", async () => {
  await expect(call("/denied")).resolves.toMatchObject({
    status: 403,
    body: { code: "CONSOLE_ACCESS_DENIED", fix: expect.any(String), message: "This Console access does not include this section." },
  })
  await expect(call("/diagnostic")).resolves.toMatchObject({
    status: 400,
    body: { code: "VITE_HUB_R0071", message: "Invalid usage window" },
  })
})

it("answers Console route errors with their 4xx status", async () => {
  await expect(call("/_vitehub/api/usage?window=bogus")).resolves.toMatchObject({ status: 400, body: { code: "VITE_HUB_R0071", message: "Invalid usage window" } })
  await expect(call("/workspace")).resolves.toMatchObject({ status: 404, body: { code: "VITE_HUB_C0001", message: "This Workspace has no retained history." } })
})

it("keeps the diagnostic fields on the thrown error", () => {
  const error = consoleRequestError(404, "Console operation not found.")
  expect(HTTPError.isError(error)).toBe(true)
  expect(error).toMatchObject({ code: "CONSOLE_NOT_FOUND", status: 404, statusCode: 404, message: "Console operation not found." })
  expect(error.fix).toEqual(expect.any(String))
})
