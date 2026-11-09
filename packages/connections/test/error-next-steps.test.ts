import { describe, expect, it } from "vitest"

import { connectionsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { errorResponse } from "../src/internal/http-routes.ts"

describe("Connection errors that need a person", () => {
  it("names the Connection, its Console page, and the CLI command to reconnect", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_NEEDS_RECONNECT({ connection: "t3:alice" })
    expect(error.fix).toBe("Open the Console page of Connection \"t3:alice\" (/_vitehub/connections?connection=t3%3Aalice) and select Reconnect. Follow the setup notes on that page, if it has them. Or run `vitehub connections connect t3:alice`.")
    expect(error.docs).toBe("https://vitehub.dev/docs/connections/diagnostics/connections_needs_reconnect")
  })

  it("names the approval, its Console tab, and the CLI command that approves it", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_APPROVAL_REQUIRED({ action: "POST /repos", approval: "apr_1", connection: "t3:alice" })
    expect(error.fix).toContain("/_vitehub/connections?connection=t3%3Aalice&tab=approvals")
    expect(error.fix).toContain("`vitehub connections approvals approve apr_1`")
  })

  it("points an API key Connection to Set key", () => {
    const error = connectionsErrorDiagnostics.CONNECTIONS_NOT_CONNECTED({ apiKey: true, connection: "stripe" })
    expect(error.fix).toContain("select Set key")
    expect(error.fix).toContain("`vitehub connections set-key stripe`")
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
      fix: expect.stringContaining("Connection \"t3:alice\""),
    })
  })
})
