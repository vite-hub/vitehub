import { describe, expect, it } from "vitest"

import { decide, envActor } from "../src/policy.ts"
import { connectionActions, matchesPattern } from "../src/catalog.ts"
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

  it("uses the rule of the nearest Agent that an Agent extends", () => {
    const definition = mailConnection({
      "agent:bot": { read: true, write: ["mail.messages.modify"], approve: false },
      "agent:base": { read: true },
    })
    const action = { action: "mail.messages.modify", definition, highRisk: false, write: true }
    expect(decide({ ...action, actor: "agent:bot-dev" })).toBe("deny")
    expect(decide({ ...action, actor: "agent:bot-dev", inherited: ["agent:bot"] })).toBe("allow")
    // A grandchild uses the nearest parent that has a rule.
    expect(decide({ ...action, actor: "agent:bot-canary", inherited: ["agent:bot-dev", "agent:bot", "agent:base"] })).toBe("allow")
    expect(decide({ ...action, actor: "agent:bot-canary", inherited: ["agent:base", "agent:bot"] })).toBe("deny")
  })

  it("keeps an explicit child rule even when it grants less than the parent rule", () => {
    const definition = mailConnection({
      "agent:bot": { read: true, write: ["mail.messages.modify"], approve: false },
      "agent:bot-dev": { read: true },
    })
    const action = { action: "mail.messages.modify", actor: "agent:bot-dev", definition, highRisk: false, inherited: ["agent:bot"], write: true }
    expect(decide(action)).toBe("deny")
    expect(decide({ ...action, action: "mail.labels.list", write: false })).toBe("allow")
  })

  it("never lets non-Agent actors inherit a rule", () => {
    const definition = mailConnection({ "agent:bot": { read: true, write: ["mail.messages.modify"], approve: false }, server: { read: true } })
    const action = { action: "mail.messages.modify", definition, highRisk: false, inherited: ["agent:bot"], write: true }
    expect(decide({ ...action, actor: "server" })).toBe("deny")
    expect(decide({ ...action, actor: "schedule:gmail" })).toBe("deny")
    expect(decide({ ...action, actor: "user:owner" })).toBe("deny")
    // Inherited entries are Agent actors only. A parent list cannot borrow a server rule.
    const server = mailConnection({ server: { read: true, write: ["mail.messages.modify"] } })
    expect(decide({ ...action, definition: server, actor: "agent:bot-dev", inherited: ["server"] })).toBe("deny")
  })

  it("requires exact high-risk and raw-fetch write authority", () => {
    const definition = mailConnection({ server: { read: true, write: true } })
    expect(decide({ action: "mail.messages.send", actor: "server", definition, highRisk: true, write: true })).toBe("deny")
    expect(decide({ action: "fetch", actor: "server", definition, highRisk: true, write: true })).toBe("deny")
  })
})
