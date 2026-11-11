import { defineAgent } from "@vite-hub/agent"
import { runAgentInvocationsCli } from "@vite-hub/agent/cli"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { afterAll, describe, expect, it, vi } from "vitest"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { signedConsoleAccess } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"


function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

// The deployed host takes only signed calls, as `console: true` does. The CLI signs with its private key.
const signer = await signedConsoleAccess("CI")
const privateKey = { [`VITEHUB_CONSOLE_PRIVATE_KEY_${signer.key.name}`]: signer.key.privateKey }
afterAll(() => {
  signer.restore()
  installConsoleAccess({ mode: "open" })
})

function setup() {
  let release!: () => void
  const finished = new Promise<void>((resolve) => { release = resolve })
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const root = "/console-invocations-cli-test"
  installConsoleInvocations(root, invocations)
  const agent = defineAgent({ driver: { run: async () => { await finished; return "done" } }, invocations, name: "support", runtime: false })
  installConsoleAgentDefinitions([{ definition: agent, fallbackName: "support" }], { invoke: true, projectRoot: root })
  const host = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(new URL(request.url).pathname).toBe("/_vitehub/rpc")
    return await handleConsoleRpcRequest(request, { waitUntil: () => undefined })
  })
  return { host, invocations, release }
}

async function cli(args: string[], fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv = privateKey) {
  const stdout = stream()
  const stderr = stream()
  const exitCode = await runAgentInvocationsCli([...args, "--url", "https://agent.example.com"], { env, stderr, stdout }, { fetch })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub agent invocations against the Console RPC handler", () => {
  it("lists, shows, and cancels a running Invocation with a signing key", async () => {
    const fixture = setup()
    const started = await handleConsoleRpcRequest(await signer.sign(new Request("https://agent.example.com/_vitehub/rpc", {
      body: operationRpcBody("agents.invoke", { agent: "support", prompt: "Wait." }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    })), { waitUntil: () => undefined })
    const { value } = await operationRpcResponseResult(started) as { value: { id: string } }
    await vi.waitFor(async () => expect((await fixture.invocations.getSummary(value.id))?.status).toBe("running"))

    const anonymous = await cli(["list"], fixture.host, {})
    expect(anonymous.exitCode).toBe(1)
    expect(anonymous.stderr).toContain("HTTP 401")

    const list = await cli(["list", "--status", "running", "--json"], fixture.host)
    expect(list.exitCode).toBe(0)
    expect(JSON.parse(list.stdout).invocations).toEqual([expect.objectContaining({ id: value.id, status: "running" })])

    // Running status is persisted before the asynchronous trace journal writes.
    await vi.waitFor(async () => expect((await fixture.invocations.get(value.id))?.observations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "agent.invocation.start" })])))
    const show = await cli(["show", value.id], fixture.host)
    expect(show.stdout).toContain(`${value.id} running`)
    expect(show.stdout).toContain("agent.invocation.start")

    const cancel = await cli(["cancel", value.id, "--json"], fixture.host)
    expect(cancel.exitCode).toBe(0)
    expect(JSON.parse(cancel.stdout)).toMatchObject({ id: value.id, outcome: "requested" })

    const missing = await cli(["cancel", "missing"], fixture.host)
    expect(missing).toMatchObject({ exitCode: 1, stderr: "Console request failed with HTTP 404: Invocation not found.\n" })
    fixture.release()
  })
})
