import { describe, expect, it } from "vitest"

import { createConnectionsCliContributor, runConnectionsCli } from "../src/cli.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { ACCESS_TOKEN, connect, createTestRuntime, REFRESH_TOKEN } from "./helpers.ts"

function cli(test = createTestRuntime()) {
  const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => test.runtime })
  const output = { stderr: "", stdout: "" }
  const context = {
    env: {},
    stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
    stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
  }
  const options = { fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new Request(input, init))) as typeof fetch, timeout: 5 }
  return {
    output,
    run: (command: string, args: string[] = []) => runConnectionsCli(command, args, context, options),
    test,
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  if (!check()) throw new Error("Timed out.")
}

describe("vitehub connections", () => {
  it("contributes the connections namespace", () => {
    const [namespace] = createConnectionsCliContributor().namespaces
    expect(namespace?.name).toBe("connections")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["list", "inspect", "connect", "activity", "approvals", "revoke"])
  })

  it("connects through a loopback callback", async () => {
    const harness = cli()
    const done = harness.run("connect", ["mail", "--json"])
    await waitFor(() => harness.output.stderr.includes("Waiting for"))
    const authorization = new URL(harness.output.stderr.match(/https:\/\/auth\.example\.com\/\S+/)![0])
    const redirect = new URL(authorization.searchParams.get("redirect_uri")!)
    expect(redirect.hostname).toBe("127.0.0.1")
    harness.test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "mail.modify" } })

    expect((await fetch(`${redirect.href}?code=code-1&state=wrong`)).status).toBe(400)
    expect((await fetch(`${redirect.href}?code=code-1&state=${authorization.searchParams.get("state")}`)).status).toBe(200)
    expect(await done).toBe(0)
    expect(JSON.parse(harness.output.stdout)).toMatchObject({ account: { email: "owner@example.com" }, status: "connected" })
    expect(harness.output.stdout + harness.output.stderr).not.toContain(ACCESS_TOKEN)
  })

  it("prints the Console connect URL for a deployed app", async () => {
    const harness = cli()
    expect(await harness.run("connect", ["mail", "--url", "https://app.example.com"])).toBe(0)
    expect(harness.output.stdout).toContain("https://app.example.com/_vitehub/connections/connect/mail")
  })

  it("lists, approves, and revokes", async () => {
    const harness = cli()
    await connect(harness.test)
    expect(await harness.run("list")).toBe(0)
    expect(harness.output.stdout).toContain("mail  example  connected  owner@example.com")

    await harness.test.runtime.client("mail", { actor: "agent:labeller" }).call("mail.messages.modify", { id: "m1", userId: "me" }).catch(() => undefined)
    harness.output.stdout = ""
    expect(await harness.run("approvals", ["--json"])).toBe(0)
    const { approvals: [approval] } = JSON.parse(harness.output.stdout) as { approvals: Array<{ id: string }> }
    expect(await harness.run("approvals", ["approve", approval!.id])).toBe(0)
    expect(harness.output.stdout).toContain("executed")

    expect(await harness.run("revoke", ["mail"])).toBe(1)
    expect(harness.output.stderr).toContain("--confirm mail")
    expect(await harness.run("revoke", ["mail", "--confirm", "mail"])).toBe(0)
    expect(harness.output.stdout).toContain("revoked")
  })

  it("exposes approval cursors in JSON and supports older-page decisions", async () => {
    const harness = cli()
    for (let index = 0; index < 101; index++) {
      await harness.test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: new Date().toISOString(), id: `approval-${index}`, input: {}, name: "mail", status: "pending" })
    }
    expect(await harness.run("approvals", ["--name", "mail", "--json"])).toBe(0)
    const first = JSON.parse(harness.output.stdout) as { approvals: Array<{ id: string }>, nextCursor: string }
    expect(first.approvals).toHaveLength(100)
    expect(first.nextCursor).toBe("approval-1")
    expect(harness.output.stderr).toBe("")
    harness.output.stdout = ""
    expect(await harness.run("approvals", ["--name", "mail", "--before", first.nextCursor, "--json"])).toBe(0)
    expect(JSON.parse(harness.output.stdout)).toMatchObject({ approvals: [{ id: "approval-0" }] })
    expect(JSON.parse(harness.output.stdout)).not.toHaveProperty("nextCursor")
    expect(await harness.run("approvals", ["deny", "approval-0"])).toBe(0)
    expect(await harness.test.store.approvals.get("approval-0")).toMatchObject({ status: "denied" })
    harness.output.stdout = ""
    expect(await harness.run("approvals", ["--name", "mail"])).toBe(0)
    expect(harness.output.stdout).not.toContain("Next page:")
    await harness.test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: new Date().toISOString(), id: "new-pending", input: {}, name: "mail", status: "pending" })
    harness.output.stdout = ""
    expect(await harness.run("approvals", ["--name", "mail"])).toBe(0)
    expect(harness.output.stdout).toContain("Next page: repeat this command with --before approval-2.")
    expect(await harness.run("approvals", ["--before"])).toBe(1)
    expect(harness.output.stderr).toContain("Missing value for --before.")
  })

  it("prints the activity timestamp", async () => {
    const harness = cli()
    await connect(harness.test)
    await harness.test.runtime.client("mail", { actor: "schedule:mail" }).call("mail.labels.list", { userId: "me" })
    expect(await harness.run("activity", ["mail"])).toBe(0)
    expect(harness.output.stdout).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ {2}succeeded {2}\S+ {2}mail\.labels\.list {2}service:schedule:mail /m)
    expect(harness.output.stdout).not.toContain("undefined")
  })

  it("rejects malformed successful management responses", async () => {
    const output = { stderr: "", stdout: "" }
    const context = {
      env: {},
      stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
      stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
    }
    const options = { fetch: async () => Response.json({ connections: [{ name: "mail" }] }) }
    expect(await runConnectionsCli("list", [], context, options)).toBe(1)
    expect(output.stderr).toContain("invalid Connections response")
    expect(output.stdout).toBe("")
  })

  it("reports errors and unknown options", async () => {
    const harness = cli()
    expect(await harness.run("inspect", ["missing"])).toBe(1)
    expect(harness.output.stderr).toContain("CONNECTION_INVALID")
    expect(await harness.run("list", ["--nope"])).toBe(1)
    expect(harness.output.stderr).toContain("Unknown option: --nope.")
  })
})
