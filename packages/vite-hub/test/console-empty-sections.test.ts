import { agentWithSkills, codexDriver, defineAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { beforeEach, expect, it } from "vitest"

import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"
import { installConsoleInvocationFallback } from "../src/console/internal.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { installConsoleEnv } from "../src/console/runtime/server/env.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

const projectRoot = "/console-empty-sections-test"

beforeEach(() => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  installConsoleInvocationFallback(invocations, projectRoot)
  installConsoleAgentDefinitions([], { invocations })
  installConsoleEnv(projectRoot, { entries: [] })
  installConsoleSections(projectRoot, ["agents", "skills", "channels", "env"])
})

function call(operation: string) {
  return handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc", {
    body: operationRpcBody(operation, {}),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
}

it("hides empty sections through RPC while keeping their readers available", async () => {
  const sections = await call("sections.list")
  expect(sections.status).toBe(200)
  await expect(operationRpcResponseResult(sections)).resolves.toMatchObject({ ok: true, value: { sections: ["agents"] } })

  const env = await call("env.get")
  expect(env.status).toBe(200)
  await expect(operationRpcResponseResult(env)).resolves.toMatchObject({ ok: true, value: { entries: [] } })
})

it("filters empty sections within the installed navigation without removing operations", async () => {
  installConsoleSections(projectRoot, ["agents", "skills", "channels", "env"], ["env"])

  const sections = await call("sections.list")
  expect(sections.status).toBe(200)
  await expect(operationRpcResponseResult(sections)).resolves.toMatchObject({ ok: true, value: { sections: [] } })

  const env = await call("env.get")
  expect(env.status).toBe(200)
  await expect(operationRpcResponseResult(env)).resolves.toMatchObject({ ok: true, value: { entries: [] } })
})

it("shows bundled Skills and declared Env through the operation reader", async () => {
  const definition = agentWithSkills(defineAgent({ driver: codexDriver(), runtime: false }), {
    review: "# Review\n\nRead the evidence.\n",
  })
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  installConsoleInvocationFallback(invocations, projectRoot)
  installConsoleAgentDefinitions([{ definition, fallbackName: "reviewer" }], { invocations })
  installConsoleEnv(projectRoot, { entries: [{
    path: "env.server.token", source: "env", secret: true, required: true, hasDefault: false,
  }] })

  const sections = await call("sections.list")
  expect(sections.status).toBe(200)
  await expect(operationRpcResponseResult(sections)).resolves.toMatchObject({ ok: true, value: { sections: ["agents", "skills", "env"] } })
})
