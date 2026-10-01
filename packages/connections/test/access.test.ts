import { describe, expect, it } from "vitest"

import { connectionActions, decide, envActor, matchesPattern } from "../src/policy.ts"
import { google } from "../src/google.ts"
import { defineConnection } from "../src/definition.ts"

import type { ConnectionActionInfo } from "../src/types.ts"

import { mailConnection } from "./helpers.ts"

describe("Connection access", () => {
  it.each(["users.drafts.delete", "users.labels.delete"] as const)("requires exact authority for permanent Gmail deletion %s", method => {
    const provider = google({ clientId: "id", clientSecret: "secret" })
    const definitions = [
      defineConnection({ provider, scopes: [] }),
      defineConnection({ provider, scopes: [], access: { server: { write: true } } }),
      defineConnection({ provider, scopes: [], access: { server: { write: "approve" } } }),
      defineConnection({ provider, scopes: [], access: { server: { write: ["gmail.users.*"] } } }),
    ]
    for (const definition of definitions) {
      const actions: ConnectionActionInfo[] = Reflect.apply(connectionActions, undefined, [definition])
      const action = actions.find(action => action.id === `gmail.${method}`)
      if (!action) throw new Error("Expected a Gmail deletion action.")
      expect(action.highRisk).toBe(true)
      expect(Reflect.apply(decide, undefined, [{ ...action, action: action.id, actor: "server", definition }])).toBe("deny")
    }
    const definition = defineConnection({ provider, scopes: [], access: { server: { write: [`gmail.${method}`], approve: false } } })
    const actions: ConnectionActionInfo[] = Reflect.apply(connectionActions, undefined, [definition])
    const action = actions.find(action => action.id === `gmail.${method}`)!
    expect(Reflect.apply(decide, undefined, [{ ...action, action: action.id, actor: "server", definition }])).toBe("allow")
  })

  it("matches exact actions and trailing namespace patterns", () => {
    expect(matchesPattern("mail.messages.modify", "mail.messages.*")).toBe(true)
    expect(matchesPattern("mail.messages.modify", "mail.messages")).toBe(false)
    expect(matchesPattern("mail.messages.modify", "*")).toBe(true)
    expect(matchesPattern("mailxmessagesxmodify", "mail.messages.modify")).toBe(false)
    expect(matchesPattern("aab", "a+b")).toBe(false)
    expect(matchesPattern("a+b", "a+b")).toBe(true)
  })

  it("maps explicit actors to audited Env actors", () => {
    expect(envActor("agent:triage")).toEqual({ id: "triage", kind: "agent" })
    expect(envActor("user:owner")).toEqual({ id: "owner", kind: "user" })
    expect(envActor("route:POST /api/labels")).toEqual({ id: "route:POST /api/labels", kind: "service" })
  })

  it("does not give Agents another actor's authority", () => {
    const definition = mailConnection({ server: { read: true, write: ["mail.messages.modify"] } })
    const action = { action: "mail.messages.modify", definition, highRisk: false, write: true }
    expect(decide({ ...action, actor: "server" })).toBe("allow")
    expect(decide({ ...action, actor: "agent:triage" })).toBe("deny")
    expect(decide({ ...action, actor: "agent:triage", approved: true })).toBe("deny")
  })

  it("requires Agent approval and preserves denial after approval", () => {
    const definition = mailConnection({ "agent:triage": { read: true, write: ["mail.messages.modify"] } })
    const action = { action: "mail.messages.modify", actor: "agent:triage", definition, highRisk: false, write: true }
    expect(decide(action)).toBe("approve")
    expect(decide({ ...action, approved: true })).toBe("allow")
    expect(decide({ ...action, action: "mail.messages.send", highRisk: true, approved: true })).toBe("deny")
  })

  it("requires exact high-risk and raw-fetch write authority", () => {
    const definition = mailConnection({ server: { read: true, write: true } })
    expect(decide({ action: "mail.messages.send", actor: "server", definition, highRisk: true, write: true })).toBe("deny")
    expect(decide({ action: "fetch", actor: "server", definition, highRisk: true, write: true })).toBe("deny")
  })
})
