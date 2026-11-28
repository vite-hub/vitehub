import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { connectionsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { errorResponse } from "../src/internal/http-routes.ts"

describe("Connection errors that need a person", () => {
  it("names the CLI command that reconnects the Connection", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: "t3:alice" })
    expect(error.fix).toBe("Run `vitehub connections connect t3:alice`, and follow the setup notes of the Connection, if it has them.")
    expect(error.docs).toBe("https://vitehub.dev/docs/connections/diagnostics/connections_needs_reconnect")
  })

  it("names the approval and the CLI command that approves it", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_APPROVAL_REQUIRED({ action: "POST /repos", approval: "apr_1", connection: "t3:alice" })
    expect(error.fix).toContain("`vitehub connections approvals approve apr_1`")
  })

  it("points an API key Connection to set-key", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ apiKey: true, connection: "stripe" })
    expect(error.fix).toContain("`vitehub connections set-key stripe`")
  })

  it("quotes a Connection name with spaces so the CLI reads it as one argument", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ connection: "team/客户 it's" })
    expect(error.fix).toContain("`vitehub connections connect 'team/客户 it'\\''s'`")
  })

  it("names the definition of an instance in an access rule fix", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_DENIED({ action: "POST /repos", actor: "agent:triage", connection: "t3:alice" })
    expect(error.fix).toBe("Allow this action for \"agent:triage\" in the `access` rules of the Connection Definition \"t3\".")
  })

  it("keeps the fix of the thrown error in a management route body", async () => {
    const response = errorResponse(connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: "t3:alice" }))
    const body = await response.json() as { error: { code: string, docs?: string, fix?: string } }
    expect(body.error).toMatchObject({
      code: "CONNECTIONS_NEEDS_RECONNECT",
      docs: "https://vitehub.dev/docs/connections/diagnostics/connections_needs_reconnect",
      fix: expect.stringContaining("vitehub connections connect t3:alice"),
    })
  })

  it("shows the code and message of a ViteHub error from another package, such as a missing Env value", async () => {
    const response = errorResponse(new ViteHubError("ENV_REQUIRED_MISSING", "[vitehub] Required Env value google.clientId is missing. Set GOOGLE_CLIENT_ID."))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: "ENV_REQUIRED_MISSING", message: "[vitehub] Required Env value google.clientId is missing. Set GOOGLE_CLIENT_ID." } })
  })

  it("hides the message of an error that is not a ViteHub error", async () => {
    const response = errorResponse(new Error("/home/app/secret path"))
    const body = await response.json() as { error: { code: string, message: string } }
    expect(body.error).toMatchObject({ code: "CONNECTIONS_REQUEST_FAILED", message: "The Connections request failed." })
  })
})
