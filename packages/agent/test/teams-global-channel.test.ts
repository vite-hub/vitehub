import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createTeamsAdapter: vi.fn(() => ({ kind: "teams-adapter" })),
  decodeThreadId: vi.fn(() => ({ conversationId: "group-1", serviceUrl: "https://group.example/" })),
  resolveTeamsAccessToken: vi.fn(async () => "access-token"),
  createTeamsConversation: vi.fn(async () => ({ body: { id: "private-1" } })),
  callTeamsConnectorApi: vi.fn(async () => ({ body: { id: "message-1" } })),
}))

vi.mock("@chat-adapter/teams", () => ({
  createTeamsAdapter: mocks.createTeamsAdapter,
  decodeThreadId: mocks.decodeThreadId,
}))
vi.mock("@chat-adapter/teams/api", () => ({
  resolveTeamsAccessToken: mocks.resolveTeamsAccessToken,
  createTeamsConversation: mocks.createTeamsConversation,
  callTeamsConnectorApi: mocks.callTeamsConnectorApi,
}))

import { teams } from "../src/channels.ts"

describe("global Teams Channel", () => {
  it("uses one credential source for inbound and outbound and sends to a private user", async () => {
    const credentials = vi.fn(() => ({ appId: "app-1", appPassword: "secret", tenantId: "tenant-1", botName: "Test Bot" }))
    const channel = teams({ global: true, credentials })
    const adapter = await (channel.adapter as () => Promise<unknown>)()

    expect(adapter).toEqual({ kind: "teams-adapter" })
    expect(mocks.createTeamsAdapter).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-1", appTenantId: "tenant-1" }))
    await expect(channel.send?.("Hello\n\nWorld", "user:user-1")).resolves.toEqual({ id: "message-1" })
    expect(mocks.createTeamsConversation).toHaveBeenCalledWith(expect.objectContaining({ members: [{ id: "user-1" }] }))
    expect(mocks.callTeamsConnectorApi).toHaveBeenCalledWith(expect.objectContaining({
      path: "v3/conversations/private-1/activities",
      body: expect.objectContaining({ textFormat: "xml", text: expect.stringContaining("<br><br>") }),
    }))
    expect(credentials).toHaveBeenCalledTimes(2)
  })

  it("posts to an existing Teams thread without creating a conversation", async () => {
    mocks.createTeamsConversation.mockClear()
    const channel = teams({ credentials: () => ({ appId: "app-1", appPassword: "secret", tenantId: "tenant-1" }) })
    await channel.send?.("Changelog", "teams:encoded-thread")

    expect(mocks.decodeThreadId).toHaveBeenCalledWith("teams:encoded-thread")
    expect(mocks.createTeamsConversation).not.toHaveBeenCalled()
    expect(mocks.callTeamsConnectorApi).toHaveBeenCalledWith(expect.objectContaining({
      path: "v3/conversations/group-1/activities",
      serviceUrl: "https://group.example/",
    }))
  })
})
