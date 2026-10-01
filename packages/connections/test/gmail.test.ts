import { describe, expect, it } from "vitest"

import { gmail, gmailOperations, google } from "../src/google.ts"
import { fakeProvider, mockFetch, setupRuntime, tokenSet } from "./helpers.ts"

import type { ConnectionClient, ConnectionEffect, ConnectionRequest } from "../src/types.ts"

const api = "https://gmail.googleapis.com/gmail/v1/users/me"

interface RecordedCall {
  effect: ConnectionEffect
  id: string
  input: unknown
  request: ConnectionRequest
  scopes: readonly string[] | undefined
}

function fakeClient() {
  const calls: RecordedCall[] = []
  const client: ConnectionClient<false> = {
    name: "gmail",
    call: async (operation, input) => {
      calls.push({ effect: operation.effect, id: operation.id, input, request: operation.request(input), scopes: operation.scopes })
      return { recorded: operation.id } as never
    },
    fetch: async () => new Response(null),
    status: async () => ({ access: {}, name: "gmail", origins: [], provider: "google", scopes: [], status: "active" }),
  }
  return { calls, client }
}

describe("gmail", () => {
  it("builds message requests", async () => {
    const { calls, client } = fakeClient()
    const mail = gmail(client)

    await mail.messages.list({ labelIds: ["INBOX", "UNREAD"], maxResults: 10, q: "from:a@example.com" })
    await mail.messages.get({ format: "metadata", id: "msg/1", metadataHeaders: ["Subject"] })
    await mail.messages.modify({ addLabelIds: ["L1"], id: "msg-1", removeLabelIds: ["UNREAD"] })
    await mail.messages.trash({ id: "msg-2" })
    await mail.messages.attachments.get({ id: "att/1", messageId: "msg-3" })

    expect(calls.map(call => [call.id, call.effect])).toEqual([
      ["gmail.messages.list", "read"],
      ["gmail.messages.get", "read"],
      ["gmail.messages.modify", "write"],
      ["gmail.messages.trash", "write"],
      ["gmail.messages.attachments.get", "read"],
    ])
    expect(calls[4]!.request).toEqual({ method: "GET", url: `${api}/messages/msg-3/attachments/att%2F1` })
    expect(calls[0]!.request).toEqual({
      method: "GET",
      query: { includeSpamTrash: undefined, labelIds: ["INBOX", "UNREAD"], maxResults: 10, pageToken: undefined, q: "from:a@example.com" },
      url: `${api}/messages`,
    })
    expect(calls[1]!.request).toEqual({ method: "GET", query: { format: "metadata", metadataHeaders: ["Subject"] }, url: `${api}/messages/msg%2F1` })
    expect(calls[2]!.request).toEqual({ body: { addLabelIds: ["L1"], removeLabelIds: ["UNREAD"] }, method: "POST", url: `${api}/messages/msg-1/modify` })
    expect(calls[3]!.request).toEqual({ method: "POST", url: `${api}/messages/msg-2/trash` })
  })

  it("builds label, draft, profile, history, and watch requests", async () => {
    const { calls, client } = fakeClient()
    const mail = gmail(client)

    await mail.labels.list()
    await mail.labels.get({ id: "Label_1" })
    await mail.labels.create({ labelListVisibility: "labelShow", name: "Receipts" })
    await mail.labels.patch({ id: "Label_1", name: "Invoices" })
    await mail.drafts.create({ raw: "cmF3", threadId: "t-1" })
    await mail.drafts.create({ raw: "cmF3" })
    await mail.profile.get()
    await mail.history.list({ historyTypes: ["messageAdded"], startHistoryId: "99" })
    await mail.watch({ labelIds: ["INBOX"], topicName: "projects/p/topics/t" })

    expect(calls.map(call => `${call.request.method} ${call.request.url.replace(api, "")}`)).toEqual([
      "GET /labels",
      "GET /labels/Label_1",
      "POST /labels",
      "PATCH /labels/Label_1",
      "POST /drafts",
      "POST /drafts",
      "GET /profile",
      "GET /history",
      "POST /watch",
    ])
    expect(calls[2]!.request.body).toEqual({ labelListVisibility: "labelShow", name: "Receipts" })
    expect(calls[3]!.request.body).toEqual({ name: "Invoices" })
    expect(calls[4]!.request.body).toEqual({ message: { raw: "cmF3", threadId: "t-1" } })
    expect(calls[5]!.request.body).toEqual({ message: { raw: "cmF3" } })
    expect(calls[7]!.request.query).toMatchObject({ historyTypes: ["messageAdded"], startHistoryId: "99" })
    expect(calls[8]!.request.body).toEqual({ labelIds: ["INBOX"], topicName: "projects/p/topics/t" })
    expect(calls[8]!.effect).toBe("write")
  })

  it("declares ids, effects, and scopes for every Operation", () => {
    for (const operation of Object.values(gmailOperations)) {
      expect(operation.id).toMatch(/^gmail\./)
      expect(["read", "write"]).toContain(operation.effect)
      expect(operation.scopes?.length).toBeGreaterThan(0)
    }
    expect(gmailOperations.messagesModify.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"])
  })

  it("serializes repeated query values through the runtime", async () => {
    const upstream = mockFetch(() => Response.json({ messages: [] }))
    const { name, runtime, store } = setupRuntime({ definition: { provider: { ...fakeProvider().provider, origins: ["https://*.googleapis.com"] } }, fetch: upstream.fetch, name: "gmail" })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await runtime.call(name, gmailOperations.messagesList, { labelIds: ["INBOX", "UNREAD"], maxResults: 5 }, { actor: { id: "server", kind: "service" } })
    expect(upstream.calls[0]!.url).toBe(`${api}/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=5`)
  })
})

describe("google", () => {
  it("adds openid and email scopes and requests offline access", async () => {
    const provider = google({ client: () => ({ clientId: "client-id" }), scopes: ["email", "https://www.googleapis.com/auth/gmail.modify"] })
    expect(provider.id).toBe("google")
    expect(provider.scopes).toEqual(["openid", "email", "https://www.googleapis.com/auth/gmail.modify"])
    expect(provider.revoke).toBeTypeOf("function")

    const url = new URL(await provider.authorizationUrl({ codeChallenge: "c", redirectUri: "https://app.example/cb", state: "s" }, { fetch: mockFetch(() => new Response(null)).fetch }))
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")
  })
})
