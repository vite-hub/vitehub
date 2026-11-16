import { expect, it } from "vitest"

import { createAuthCliContributor } from "../src/cli.ts"
import { authErrorDiagnostics } from "../src/error-diagnostics.ts"

async function events(args: string[], env: Record<string, string | undefined> = {}, fetch?: typeof globalThis.fetch) {
  let stderr = ""
  const feature = createAuthCliContributor({ fetch }).namespaces[0]!.features.find(entry => entry.name === "events")!
  const context = { env, stderr: { write: (text: string) => { stderr += text } }, stdout: { write: () => {} } }
  // SAFETY: The events command reads only env, stderr, and stdout of the CLI context.
  const code = await feature.run(args, context as never)
  return { code, stderr }
}

it("gives each `vitehub auth events` code a fix and its own docs page", () => {
  for (const error of [
    authErrorDiagnostics.AUTH_EVENTS_OPTION_INVALID({ option: "--color", problem: "unknown" }),
    authErrorDiagnostics.AUTH_EVENTS_REQUEST_FAILED({ status: 403 }),
    authErrorDiagnostics.AUTH_EVENTS_URL_INSECURE(),
    authErrorDiagnostics.AUTH_EVENTS_URL_MISSING(),
  ]) {
    expect(error.fix, error.code).toMatch(/\S/)
    expect(error.docs, error.code).toBe(`https://vitehub.dev/docs/auth/diagnostics/${error.code.toLowerCase()}`)
  }
})

it("prints the fix of each `vitehub auth events` failure", async () => {
  expect(await events(["--color"])).toEqual({ code: 1, stderr: expect.stringContaining("Fix: Pass only the options that `vitehub auth events --help` lists") })
  expect(await events(["--type"], { VITEHUB_AUTH_URL: "https://app.example.com/api/auth" })).toEqual({ code: 1, stderr: expect.stringContaining("Missing value for --type.") })
  expect((await events([])).stderr).toContain("Fix: Pass `--url` with the Auth base URL")
  expect((await events(["--url", "http://app.example.com/api/auth"])).stderr).toContain("Fix: Pass an `https://` Auth base URL")
  const refused = await events(["--url", "https://app.example.com/api/auth"], {}, async () => new Response(null, { status: 403 }))
  expect(refused).toEqual({ code: 1, stderr: expect.stringContaining("Auth events returned HTTP 403.\nFix: Return true from `events.authorize`") })
})
