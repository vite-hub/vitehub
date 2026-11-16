import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { inspectServerEnv } from "@vite-hub/env/server"
import { envOperations } from "../../env/dist/operations.js"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { signedConsoleAccess } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const canary = "canary-41d8e2-never-in-a-response"

// The Env plugin generates this module for the app. Here it inspects a fixed registry, as the generated module does.
vi.mock("../../env/dist/runtime/server-env.js", () => ({
  inspectServerEnv: () => inspectServerEnv({
    token: { required: true, schema: { kind: "string" }, secret: true, source: { kind: "env", label: "env:RPC_TOKEN", name: "RPC_TOKEN", serializable: true } },
    webhook: { required: true, schema: { kind: "string" }, secret: true, source: { kind: "env", label: "env:RPC_WEBHOOK", name: "RPC_WEBHOOK", serializable: true } },
  }),
}))

let signer: Awaited<ReturnType<typeof signedConsoleAccess>>

function request(): Request {
  return new Request("https://app.example.com/_vitehub/rpc", {
    body: operationRpcBody("env.inspect", {}),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  })
}

beforeEach(async () => {
  installConsoleOperations([{ operations: envOperations, plugin: "@vite-hub/env/vite" }])
  signer = await signedConsoleAccess()
})

afterEach(() => {
  signer.restore()
  installConsoleOperations([])
  installConsoleAccess({ mode: "open" })
})

describe("env.inspect over the signed RPC endpoint", () => {
  it("returns the status of the deployed app's Server Env from its bindings, without values", async () => {
    const response = await handleConsoleRpcRequest(await signer.sign(request()), { env: { RPC_TOKEN: canary } })
    expect(response.status).toBe(200)
    const body = await operationRpcResponseResult(response)
    expect(body).toEqual({
      ok: true,
      value: {
        entries: [
          { blocking: false, name: "RPC_TOKEN", names: ["RPC_TOKEN"], path: "env.server.token", required: true, secret: true, source: "env", status: "available" },
          { blocking: true, names: ["RPC_WEBHOOK"], path: "env.server.webhook", required: true, secret: true, source: "env", status: "missing" },
        ],
        ok: false,
      },
    })
    expect(JSON.stringify(body)).not.toContain(canary)
  })

  it("rejects an unsigned call like every other operation", async () => {
    const response = await handleConsoleRpcRequest(request(), { env: { RPC_TOKEN: canary } })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(canary)
  })

  it("rejects a call signed by an unknown key", async () => {
    const other = await signedConsoleAccess("OTHER")
    other.restore()
    installConsoleAccess({ mode: "token" })
    const response = await handleConsoleRpcRequest(await other.sign(request()), { env: { RPC_TOKEN: canary } })
    expect(response.status).toBe(401)
  })
})
