import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { createConnectionsCliContributor, runConnectionsCli } from "../src/cli.ts"
import { defineConnection } from "../src/definition.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { ACCESS_TOKEN, connect, createTestRuntime, REFRESH_TOKEN, testProvider } from "./helpers.ts"

function cli(test = createTestRuntime()) {
  const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => test.runtime })
  const output = { stderr: "", stdout: "" }
  const context = {
    env: {},
    stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
    stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
  }
  const options = { openBrowser: false as const, fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new Request(input, init))) as typeof fetch, timeout: 5 }
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
    expect(namespace?.features.map(feature => feature.name)).toEqual(["list", "inspect", "connect", "export", "import", "models", "set-key", "activity", "approvals", "revoke"])
  })

  it("connects through a loopback callback", async () => {
    const harness = cli()
    const done = harness.run("connect", ["mail", "--json"])
    await waitFor(() => harness.output.stderr.includes("Waiting for"))
    const authorization = new URL(harness.output.stderr.match(/https:\/\/auth\.example\.com\/\S+/)![0])
    const redirect = new URL(authorization.searchParams.get("redirect_uri")!)
    expect(redirect.hostname).toBe("127.0.0.1")
    harness.test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "mail.modify" } })

    const state = authorization.searchParams.get("state")!
    const sameLength = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`
    for (const wrong of ["wrong", `${state}x`, sameLength]) {
      expect((await fetch(`${redirect.href}?code=code-1&state=${encodeURIComponent(wrong)}`)).status).toBe(400)
    }
    expect((await fetch(`${redirect.href}?code=code-1&state=${state}`)).status).toBe(200)
    expect(await done).toBe(0)
    expect(JSON.parse(harness.output.stdout)).toMatchObject({ account: { email: "owner@example.com" }, status: "connected" })
    expect(harness.output.stdout + harness.output.stderr).not.toContain(ACCESS_TOKEN)
  })

  it("waits for the sign-in as long as the authorization link works", async () => {
    const output = { stderr: "", stdout: "" }
    const context = {
      env: {},
      stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
      stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
    }
    const expiresAt = new Date(Date.now() + 150)
    const fetch = (async () => Response.json({ expiresAt: expiresAt.toISOString(), state: "state-1", url: "https://auth.example.com/authorize" })) as typeof globalThis.fetch
    expect(await runConnectionsCli("connect", ["chatgpt", "--url", "http://127.0.0.1:4741", "--port", "47991"], context, { fetch, openBrowser: false })).toBe(1)
    const until = expiresAt.toTimeString().slice(0, 5)
    expect(output.stderr).toContain(`The link works one time, until ${until} (0 minutes).\nWaiting for http://127.0.0.1:47991/callback ...\n`)
    expect(output.stderr).toContain(`The browser did not return to http://127.0.0.1:47991/callback before ${until}, when the link expired. Run \`vitehub connections connect chatgpt\` again.\n`)
  })

  it("names the fix when the authorization link expired", async () => {
    const harness = cli()
    const done = harness.run("connect", ["mail"])
    await waitFor(() => harness.output.stderr.includes("Waiting for"))
    expect(harness.output.stderr).toContain("The link works one time, until")
    const authorization = new URL(harness.output.stderr.match(/https:\/\/auth\.example\.com\/\S+/)![0])
    harness.test.now.value += 10 * 60_000
    const redirect = authorization.searchParams.get("redirect_uri")!
    expect((await fetch(`${redirect}?code=code-1&state=${authorization.searchParams.get("state")}`)).status).toBe(200)
    expect(await done).toBe(1)
    expect(harness.output.stderr).toContain("The authorization link expired or was already used. Each link works one time, for 10 minutes. (CONNECTIONS_AUTHORIZATION_EXPIRED)\nRun `vitehub connections connect <name>` again, or connect again from the Console, and finish the sign-in within 10 minutes.\n")
  })

  it.each(["list", "inspect"])("preserves public OAuth metadata in JSON %s", async (command) => {
    const harness = cli(createTestRuntime(async () => defineConnection({ provider: { ...testProvider(), mcp: "https://mcp.example.com/mcp" }, scopes: [] })))
    await connect(harness.test)
    const expected = await harness.test.runtime.inspect("mail")
    expect(expected).toMatchObject({ mcp: "https://mcp.example.com/mcp", connectedAt: expect.any(String), refreshedAt: expect.any(String) })
    expect(await harness.run(command, [...(command === "inspect" ? ["mail"] : []), "--json"])).toBe(0)
    const output = JSON.parse(harness.output.stdout)
    expect(command === "list" ? output[0] : output).toEqual(expected)
    expect(harness.output.stdout).not.toContain(ACCESS_TOKEN)
    expect(harness.output.stdout).not.toContain(REFRESH_TOKEN)
  })

  it("prints the Console connect URL for a deployed app", async () => {
    const harness = cli()
    expect(await harness.run("connect", ["mail", "--url", "https://app.example.com"])).toBe(0)
    expect(harness.output.stdout).toContain("https://app.example.com/_vitehub/connections/connect/mail")
  })

  it("preserves the app base path for management requests and connect URLs", async () => {
    const requests: string[] = []
    const output = { stderr: "", stdout: "" }
    const context = {
      env: {},
      stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
      stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
    }
    const options = {
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input))
        return Response.json({ connections: [] })
      },
    }
    expect(await runConnectionsCli("list", ["--url", "https://app.example.com/portal/"], context, options)).toBe(0)
    expect(await runConnectionsCli("connect", ["mail", "--url", "https://app.example.com/portal/"], context, options)).toBe(0)
    expect(requests).toEqual(["https://app.example.com/portal/_vitehub/connections"])
    expect(output.stdout).toContain("https://app.example.com/portal/_vitehub/connections/connect/mail")
  })

  it("finds the running dev server of the project without --url", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-connections-cli-"))
    try {
      await mkdir(join(root, ".vitehub"))
      // A Nuxt dev server on a port other than 5173 records its URL with the app base.
      await writeFile(join(root, ".vitehub/dev-server.json"), JSON.stringify({ root, url: "http://127.0.0.1:4741/docs/" }))
      const requests: string[] = []
      const context = { env: {}, rootDir: root, stderr: { write: () => true }, stdout: { write: () => true } }
      const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
        requests.push(String(input))
        return Response.json({ connections: [] })
      }) as typeof globalThis.fetch
      expect(await runConnectionsCli("list", [], context, { fetch })).toBe(0)
      expect(await runConnectionsCli("list", [], { ...context, env: { VITEHUB_CONNECTIONS_URL: "http://127.0.0.1:3000" } }, { fetch })).toBe(0)
      expect(requests).toEqual(["http://127.0.0.1:4741/docs/_vitehub/connections", "http://127.0.0.1:3000/_vitehub/connections"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("lists, approves, and revokes", async () => {
    const harness = cli()
    await connect(harness.test)
    expect(await harness.run("list")).toBe(0)
    expect(harness.output.stdout).toContain("mail  example  connected  owner@example.com")

    await harness.test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).call("mail.messages.modify", { id: "m1", userId: "me" }).catch(() => undefined)
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
    const options = { openBrowser: false as const, fetch: async () => Response.json({ connections: [{ name: "mail" }] }) }
    expect(await runConnectionsCli("list", [], context, options)).toBe(1)
    expect(output.stderr).toContain("invalid Connections response")
    expect(output.stdout).toBe("")
  })

  it("stops waiting for an app that never answers", async () => {
    const output = { stderr: "", stdout: "" }
    const context = {
      env: {},
      stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
      stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
    }
    // A dev server that rebuilds Nitro can accept the request and never answer.
    const fetch = (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    })) as typeof globalThis.fetch
    expect(await runConnectionsCli("list", ["--url", "http://127.0.0.1:4741"], context, { fetch, openBrowser: false, requestTimeout: 0.05 })).toBe(1)
    expect(output.stderr).toBe("http://127.0.0.1:4741 did not answer in 0.05 seconds. If the server is restarting, wait until it is ready, then run the command again.\n")
  })

  it("reports errors and unknown options", async () => {
    const harness = cli()
    expect(await harness.run("inspect", ["missing"])).toBe(1)
    expect(harness.output.stderr).toContain("CONNECTIONS_NOT_FOUND")
    expect(await harness.run("list", ["--nope"])).toBe(1)
    expect(harness.output.stderr).toContain("Unknown option: --nope.")
  })
})
