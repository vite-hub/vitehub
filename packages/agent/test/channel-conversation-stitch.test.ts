import { describe, expect, it } from "vitest"

import { materializeChannelArchive, renderChannelConversationMarkdown, stitchChannelConversation, summarizeChannelConversation } from "../src/internal/channel-conversation.ts"

const at = (minute: number) => Date.parse(`2026-06-10T12:${String(minute).padStart(2, "0")}:00.000Z`)
const provider = (id: string, text: string, minute: number, isMe = false) => ({
  attachments: [],
  author: { fullName: isMe ? "Bot" : "Maxi", isMe, userId: isMe ? "self" : "1" },
  id,
  metadata: { dateSent: new Date(at(minute)).toISOString() },
  text,
  threadId: "t",
})

describe("stitchChannelConversation", () => {
  it("keeps a provider message once when a transcript has it too, by id or by role, text, and time", () => {
    const messages = stitchChannelConversation({
      invocations: [],
      provider: [provider("2", "second", 2), provider("3", "reply", 3, true)],
      threadId: "t",
      transcripts: [
        { id: "a", platformMessageId: "1", role: "user", text: "first", threadId: "t", timestamp: at(1), userKey: "telegram:1" },
        { id: "b", platformMessageId: "2", role: "user", text: "second", threadId: "t", timestamp: at(2), userKey: "telegram:1" },
        // No platform id: it matches the reply by role, text, and a time within a minute.
        { id: "c", role: "assistant", text: "reply", threadId: "t", timestamp: at(3) + 20_000 },
        { id: "d", role: "assistant", text: "a reply nobody else has", threadId: "t", timestamp: at(4) },
      ],
    })
    expect(messages.map(message => `${message.source}:${message.id}:${message.text}`)).toEqual([
      "transcript:1:first",
      "provider:2:second",
      "provider:3:reply",
      "transcript:transcript:d:a reply nobody else has",
    ])
  })

  it("names the Invocation on its message and the replies up to the next person", () => {
    const messages = stitchChannelConversation({
      invocations: [
        { createdAt: new Date(at(1)).toISOString(), id: "run-1", replies: [], sourceMessageId: "1", status: "completed", updatedAt: new Date(at(2)).toISOString() },
        { createdAt: new Date(at(5)).toISOString(), id: "run-2", replies: [], sourceMessageId: "4", status: "failed", updatedAt: new Date(at(5)).toISOString() },
      ],
      provider: [provider("1", "q1", 1), provider("2", "...", 2, true), provider("3", "a1", 2, true), provider("4", "q2", 5)],
      threadId: "t",
      transcripts: [],
    })
    expect(messages.map(message => [message.id, message.invocationId])).toEqual([["1", "run-1"], ["2", "run-1"], ["3", "run-1"], ["4", "run-2"]])
  })

  it("adds the prompt and the reply that only the journal has, once", () => {
    const invocation = { createdAt: new Date(at(1)).toISOString(), id: "run-1", prompt: "question", replies: ["answer", "one more thing"], sourceMessageId: "1", status: "completed", updatedAt: new Date(at(2)).toISOString() }
    const messages = stitchChannelConversation({ invocations: [invocation], provider: [], threadId: "t", transcripts: [] })
    expect(messages.map(message => `${message.role}/${message.source}:${message.text}`)).toEqual(["user/invocation:question", "assistant/invocation:answer", "assistant/invocation:one more thing"])
    expect(new Set(messages.map(message => message.id)).size).toBe(3)
    // When the provider still has the messages, the journal adds nothing.
    const full = stitchChannelConversation({ invocations: [{ ...invocation, replies: ["answer"] }], provider: [provider("1", "question", 1), provider("2", "answer", 2, true)], threadId: "t", transcripts: [] })
    expect(full.map(message => message.source)).toEqual(["provider", "provider"])
    expect(full.map(message => message.invocationId)).toEqual(["run-1", "run-1"])
  })

  it("summarizes the people and the last message", () => {
    const messages = stitchChannelConversation({ invocations: [], provider: [provider("1", "q", 1), provider("2", "a", 9, true)], threadId: "t", transcripts: [] })
    expect(summarizeChannelConversation(messages)).toEqual({ lastMessageAt: new Date(at(9)).toISOString(), participants: ["Maxi"] })
  })
})

describe("materializeChannelArchive and renderChannelConversationMarkdown", () => {
  const archive = {
    messages: [{
      attachments: [{ data: Buffer.from("abc").toString("base64"), mimeType: "image/png", name: "../meal photo.png", type: "image" }, { name: "spec.pdf", unavailable: true, url: "https://cdn.example.com/spec.pdf" }],
      author: { fullName: "Maxi" },
      id: "1",
      invocationId: "run-1",
      metadata: { dateSent: "2026-06-10T12:01:00.000Z" },
      role: "user",
      text: "look\nat this",
    }],
  }

  it("moves the data of an attachment into a numbered media file with a safe name", () => {
    const { archive: files, media } = materializeChannelArchive(archive)
    expect(media).toEqual([{ base64: "YWJj", mimeType: "image/png", path: "media/0001-meal-photo.png", size: 3 }])
    expect(files.messages[0]!.attachments).toEqual([
      { file: "media/0001-meal-photo.png", mimeType: "image/png", name: "../meal photo.png", type: "image" },
      { name: "spec.pdf", unavailable: true, url: "https://cdn.example.com/spec.pdf" },
    ])
  })

  it("renders author and time headers, the text, and a link for each attachment", () => {
    const markdown = renderChannelConversationMarkdown({ agent: "support", channel: "telegram", exportedAt: "2026-10-25T10:00:00.000Z", messages: materializeChannelArchive(archive).archive.messages, provider: "telegram", retention: { durable: false, maxMessages: 100, ttlMs: 604_800_000 }, threadId: "telegram:1" })
    expect(markdown).toBe([
      "# Conversation telegram:1",
      "",
      "- Agent: support",
      "- Channel: telegram (telegram)",
      "- Messages: 1",
      "- Exported: 2026-10-25 10:00:00 UTC",
      "- Warning: transcripts are not durable. The provider keeps 100 messages for 7 days, so older messages may be missing.",
      "",
      "### Maxi · 2026-06-10 12:01:00 UTC",
      "",
      "look",
      "at this",
      "",
      "- Attachment: [../meal photo.png](media/0001-meal-photo.png)",
      "- Attachment: [spec.pdf](https://cdn.example.com/spec.pdf) (not included)",
      "",
      "_Invocation run-1_",
      "",
    ].join("\n"))
  })
})
