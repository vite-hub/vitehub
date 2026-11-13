import { describe, expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { google } from "../src/google.ts"
import { connect, createTestRuntime } from "./helpers.ts"

function setup() {
  return createTestRuntime(async () => ({ default: defineConnection({ provider: { ...google({ clientId: "client-id", clientSecret: "client-secret" }), tokenEndpoint: "https://auth.example.com/token" }, api: { gmail: ["users.*"] }, scopes: ["https://www.googleapis.com/auth/gmail.modify"] }) }))
}

describe("typed Gmail catalog", () => {
  it("encodes paths, repeated query values, and message bodies through the runtime", async () => {
    const test = setup()
    await connect(test, { scope: "openid email https://www.googleapis.com/auth/gmail.modify" })
    const client = test.runtime.client("mail", {})
    await client.call("gmail.users.messages.list", { userId: "me", labelIds: ["INBOX", "UNREAD"], maxResults: 5 })
    await client.call("gmail.users.messages.get", { userId: "me", id: "a/b", format: "full" })
    await client.call("gmail.users.messages.modify", { userId: "me", id: "a/b", requestBody: { addLabelIds: ["L1"] } })
    await client.call("gmail.users.drafts.create", { userId: "me", requestBody: { message: { raw: "cmF3", threadId: "t-1" } } })
    const calls = test.provider.calls.filter(call => call.url.startsWith("https://gmail.googleapis.com/"))
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "GET https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=5",
      "GET https://gmail.googleapis.com/gmail/v1/users/me/messages/a%2Fb?format=full",
      "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/a%2Fb/modify",
      "POST https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    ])
    expect(JSON.parse(calls[2]!.body!)).toEqual({ addLabelIds: ["L1"] })
    expect(JSON.parse(calls[3]!.body!)).toEqual({ message: { raw: "cmF3", threadId: "t-1" } })
  })

  it("keeps the typed methods that mail automation uses", async () => {
    const test = setup()
    await connect(test, { scope: "openid email https://www.googleapis.com/auth/gmail.modify" })
    const client = test.runtime.client("mail", {})
    await client.call("gmail.users.messages.attachments.get", { userId: "me", messageId: "m1", id: "a1" })
    await client.call("gmail.users.history.list", { userId: "me", startHistoryId: "7" })
    await client.call("gmail.users.getProfile", { userId: "me" })
    await client.call("gmail.users.threads.list", { userId: "me", q: "is:unread" })
    await client.call("gmail.users.labels.list", { userId: "me" })
    const calls = test.provider.calls.filter(call => call.url.startsWith("https://gmail.googleapis.com/"))
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/a1",
      "GET https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=7",
      "GET https://gmail.googleapis.com/gmail/v1/users/me/profile",
      "GET https://gmail.googleapis.com/gmail/v1/users/me/threads?q=is%3Aunread",
      "GET https://gmail.googleapis.com/gmail/v1/users/me/labels",
    ])
  })

  it("reaches Gmail endpoints outside the typed methods with fetch()", async () => {
    const provider = { ...google({ clientId: "client-id", clientSecret: "client-secret" }), tokenEndpoint: "https://auth.example.com/token" }
    const test = createTestRuntime(async () => ({ default: defineConnection({ access: { server: { read: true, write: ["fetch"] } }, provider, scopes: ["https://www.googleapis.com/auth/gmail.settings.basic"] }) }))
    await connect(test, { scope: "openid email https://www.googleapis.com/auth/gmail.settings.basic" })
    const client = test.runtime.client("mail", {})
    const imap = await client.fetch("https://gmail.googleapis.com/gmail/v1/users/me/settings/imap")
    const watch = await client.fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", { body: JSON.stringify({ topicName: "projects/app/topics/gmail" }), method: "POST" })
    expect([imap.status, watch.status]).toEqual([200, 200])
    const calls = test.provider.calls.filter(call => call.url.startsWith("https://gmail.googleapis.com/"))
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "GET https://gmail.googleapis.com/gmail/v1/users/me/settings/imap",
      "POST https://gmail.googleapis.com/gmail/v1/users/me/watch",
    ])
    expect(calls[1]!.body).toBe(JSON.stringify({ topicName: "projects/app/topics/gmail" }))
  })

  it("adds identity scopes and requests offline access through authorization", async () => {
    const test = setup()
    const flow = await test.runtime.authorize({ actor: "user:owner", name: "mail", redirectUri: "https://app.example/cb" })
    const url = new URL(flow.url)
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.modify")
  })
})
