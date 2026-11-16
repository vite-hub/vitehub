import { expect, it } from "vitest"

import { runConnectionsCli } from "../src/cli.ts"
import { connectionsErrorDiagnostics } from "../src/error-diagnostics.ts"

const codes = [
  "CONNECTIONS_CLI_ARGUMENTS_INVALID",
  "CONNECTIONS_CLI_CALLBACK_FAILED",
  "CONNECTIONS_CLI_CREDENTIAL_FILE_INVALID",
  "CONNECTIONS_CLI_REQUEST_FAILED",
  "CONNECTIONS_CLI_SERVER_UNREACHABLE",
  "CONNECTIONS_CLI_TRANSPORT_INSECURE",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  const error = connectionsErrorDiagnostics[code]({ problem: "p" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/connections/diagnostics/${code.toLowerCase()}`)
})

it("prints the fix of an unknown option and of a server that does not answer", async () => {
  let stderr = ""
  const context = { env: {}, stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true } }, stdout: { write: () => true } }
  expect(await runConnectionsCli("list", ["--nope"], context, { openBrowser: false })).toBe(1)
  expect(stderr).toContain("Unknown option: --nope.")
  expect(stderr).toContain("Fix: Run `vitehub connections --help`")
  stderr = ""
  const offline = (async () => { throw new TypeError("fetch failed") }) as typeof fetch
  expect(await runConnectionsCli("list", ["--url", "http://localhost:9"], context, { fetch: offline, openBrowser: false, timeout: 1 })).toBe(1)
  expect(stderr).toContain("Fix: Start the development server")
})
