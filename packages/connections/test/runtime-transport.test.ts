import { expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { apiKey } from "../src/api-key.ts"
import { defineConnection } from "../src/definition.ts"
import { connect, createTestRuntime, testProvider } from "./helpers.ts"

it.each(["oauth2", "api-key"] as const)("confines %s catalog requests to credential origins before approval", async (kind) => {
  const apis = {
    resources: {
      rootUrl: "https://mail.example.com/",
      methods: { get: ["GET", "{+resource}", false], update: ["POST", "{+resource}", true] } as const,
    },
  }
  const definition = defineConnection<object>({
    ...(kind === "api-key" ? { provider: apiKey({ apis, origins: ["https://mail.example.com"] }) } : { provider: { ...testProvider(), apis }, scopes: ["mail.modify"] }),
    access: { "agent:worker": { read: true, write: "approve" } },
  })
  const test = createTestRuntime(definition)
  if (kind === "api-key") await test.runtime.setKey({ key: "stored-key", name: "mail" })
  else await connect(test)
  test.provider.valid.add("stored-key")
  const before = test.provider.calls.length
  const client = test.runtime.client("mail", { access: agentEnvAccess({ name: "worker" }) })
  for (const resource of ["https://foreign.example.com/items", "//foreign.example.com/items"]) {
    for (const action of ["resources.get", "resources.update"]) {
      await expect(client.call(action, { resource })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    }
  }
  expect(test.provider.calls).toHaveLength(before)
  expect((await test.runtime.approvals()).approvals).toEqual([])
  await expect(client.call("resources.get", { resource: "mail/v1/labels" })).resolves.toEqual({ labels: [{ id: "INBOX" }] })
})
