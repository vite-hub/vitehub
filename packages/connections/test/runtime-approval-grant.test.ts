import { describe, expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

async function pending(test: ReturnType<typeof createTestRuntime>): Promise<string> {
  await expect(test.runtime.client("mail", { access: agentEnvAccess({ name: "writer" }) }).call("mail.messages.modify", { id: "m1", userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
  const approvals = (await test.runtime.approvals({ status: "pending" })).approvals
  return approvals[0]!.id
}

describe("approval grant binding", () => {
  it("rejects an old approval before refreshing a replacement grant", async () => {
    const test = createTestRuntime(mailConnection({ "agent:writer": { read: true, write: ["mail.messages.modify"] } }))
    await connect(test)
    const id = await pending(test)
    await connect(test, { access_token: "reauthorized-token", expires_in: 1 })
    test.provider.valid.add("reauthorized-token")
    const before = test.provider.calls.length
    await expect(test.runtime.approve({ id })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toHaveLength(before)
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
    expect(await test.store.approvals.get(id)).toMatchObject({ status: "failed" })
  })

  it.each(["account-1", "account-2"])("rejects a previous approval after reconnect to %s", async (account) => {
    const test = createTestRuntime(mailConnection({ "agent:writer": { read: true, write: ["mail.messages.modify"] } }))
    await connect(test)
    const id = await pending(test)
    await test.runtime.revoke({ name: "mail" })
    await connect(test, { id_token: account, access_token: "reconnected-token" })
    test.provider.valid.add("reconnected-token")
    const before = test.provider.calls.length
    await expect(test.runtime.approve({ id })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toHaveLength(before)
    expect(await test.store.approvals.get(id)).toMatchObject({ status: "failed" })
  })

  it("preserves an approval when the same grant refreshes", async () => {
    const test = createTestRuntime(mailConnection({ "agent:writer": { read: true, write: ["mail.messages.modify"] } }))
    await connect(test)
    const id = await pending(test)
    test.now.value += 3_600_000
    test.provider.tokenResponses.push({ body: { access_token: "refreshed-token", expires_in: 3600 } })
    test.provider.valid.add("refreshed-token")
    await expect(test.runtime.approve({ id })).resolves.toMatchObject({ approval: { status: "executed" } })
  })
})
