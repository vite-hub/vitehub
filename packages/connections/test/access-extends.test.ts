import { describe, expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

import type { UseConnectionOptions } from "../src/types.ts"

const modify = ["mail.messages.modify", { id: "m1", userId: "me" }] as const

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the call to fail.")
}

describe("Connection access through Agent extends", () => {
  it("lets a registered child Agent use the rule of the Agent it extends", async () => {
    const test = createTestRuntime(mailConnection({ "agent:bot": { read: true, write: ["mail.messages.modify"], approve: false } }))
    await connect(test)
    const child = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-dev" }, {}, ["bot"]) })
    await expect(child.call(...modify)).resolves.toEqual({ id: "message-1" })
    const grandchild = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-canary" }, {}, ["bot-dev", "bot"]) })
    await expect(grandchild.call(...modify)).resolves.toEqual({ id: "message-1" })
    // The same Agent without parents is an inline Agent that `runAgent()` ran. It gets only rules that name it.
    const inline = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-dev" }) })
    expect(await rejection(inline.call(...modify))).toMatchObject({ code: "CONNECTION_DENIED" })
  })

  it("keeps an explicit child rule that grants less", async () => {
    const test = createTestRuntime(mailConnection({
      "agent:bot": { read: true, write: ["mail.messages.modify"], approve: false },
      "agent:bot-dev": { read: true },
    }))
    await connect(test)
    const child = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-dev" }, {}, ["bot"]) })
    expect(await rejection(child.call(...modify))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(child.call("mail.labels.list", { userId: "me" })).resolves.toBeDefined()
  })

  it("ignores parents that do not come from the Agent runtime", async () => {
    const test = createTestRuntime(mailConnection({ "agent:bot": { read: true } }))
    await connect(test)
    const calls = test.provider.calls.length
    const minted = agentEnvAccess({ name: "bot-dev" })
    const forged = [
      { access: { actor: { id: "bot-dev", kind: "agent" }, parents: ["bot"] } },
      { access: { ...agentEnvAccess({ name: "bot-dev" }, {}, ["bot"]) } },
      { access: Object.assign(Object.create(minted), { parents: ["bot"] }) },
    ] as unknown as UseConnectionOptions[]
    for (const options of forged) {
      expect(await rejection(test.runtime.client("mail", options).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" })
    }
    // A name that only looks like an extension of `bot` inherits nothing.
    expect(await rejection(test.runtime.client("mail", { access: minted }).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("replays an approval with the inherited rule that requested it", async () => {
    const test = createTestRuntime(mailConnection({ "agent:bot": { read: true, write: ["mail.messages.modify"] } }))
    await connect(test)
    const child = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-dev" }, {}, ["bot"]) })
    expect(await rejection(child.call(...modify))).toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const [approval] = (await test.runtime.approvals({ status: "pending" })).approvals
    expect(approval).toMatchObject({ actor: "agent:bot-dev", input: { inherited: ["agent:bot"] } })
    await expect(test.runtime.approve({ id: approval!.id })).resolves.toMatchObject({ approval: { status: "executed" } })
  })

  it("rejects a stored approval whose inherited set is not a list of Agent actors", async () => {
    const test = createTestRuntime(mailConnection({ "agent:bot": { read: true, write: ["mail.messages.modify"] } }))
    await connect(test)
    const child = test.runtime.client("mail", { access: agentEnvAccess({ name: "bot-dev" }, {}, ["bot"]) })
    await rejection(child.call(...modify))
    const [approval] = (await test.runtime.approvals({ status: "pending" })).approvals
    // A changed store row cannot widen the replayed decision to a non-Agent rule.
    const tampered = { ...approval!, id: "approval_tampered", input: { ...(approval!.input as object), inherited: ["server"] } }
    await test.store.approvals.create(tampered)
    const before = test.provider.calls.length
    await expect(test.runtime.approve({ id: tampered.id })).rejects.toBeDefined()
    expect(test.provider.calls).toHaveLength(before)
  })
})
