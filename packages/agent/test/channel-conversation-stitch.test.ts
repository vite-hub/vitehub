import { describe, expect, it } from "vitest"

import {
  decodeChannelCursor,
  encodeChannelCursor,
  inlineChannelArchiveMedia,
  materializeChannelArchive,
  pageAfterChannelCursor,
  renderChannelConversationMarkdown,
  stitchChannelConversation,
  stripChannelModelHeader,
  summarizeChannelConversation,
} from "../src/internal/channel-conversation.ts"

const at = (minute: number, second = 0) => Date.parse(`2026-06-10T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`)
const provider = (id: string, text: string, minute: number, isMe = false, extra: Record<string, unknown> = {}) => ({
  attachments: [],
  author: { fullName: isMe ? "Bot" : "Maxi", isMe, userId: isMe ? "self" : "1" },
  id,
  metadata: { dateSent: new Date(at(minute)).toISOString() },
  text,
  threadId: "t",
  ...extra,
})
const transcript = (id: string, role: "assistant" | "user", text: string, timestamp: number, platformMessageId?: string) => ({
  id,
  ...(platformMessageId ? { platformMessageId } : {}),
  role,
  text,
  threadId: "t",
  timestamp,
  userKey: "telegram:1",
})
const stitch = (input: Partial<Parameters<typeof stitchChannelConversation>[0]>) => stitchChannelConversation({ invocations: [], provider: [], threadId: "t", transcripts: [], ...input })
const show = (messages: ReturnType<typeof stitch>) => messages.map(message => `${message.source}:${message.id}:${message.text}`)

describe("stitchChannelConversation", () => {
  it("keeps a message once when two sources have it, by id or by role, text, and time", () => {
    const messages = stitch({
      provider: [provider("2", "second", 2), provider("3", "reply", 3, true)],
      transcripts: [
        transcript("a", "user", "first", at(1), "1"),
        transcript("b", "user", "second", at(2), "2"),
        // No platform id: it matches the reply by role, text, and a time within a minute.
        transcript("c", "assistant", "reply", at(3) + 20_000),
        transcript("d", "assistant", "a reply nobody else has", at(4)),
      ],
    })
    expect(show(messages)).toEqual(["transcript:1:first", "provider:2:second", "provider:3:reply", "transcript:transcript:d:a reply nobody else has"])
  })

  it("matches an entry without an id to a message of any source, once for each message", () => {
    const messages = stitch({
      transcripts: [
        transcript("a", "user", "ok", at(1), "7"),
        // Matches the entry with an id, which is a transcript entry and not a provider message.
        transcript("b", "user", "ok", at(1, 30)),
        // Only one entry per message: the second "ok" is a message of its own.
        transcript("c", "user", "ok", at(1, 40)),
      ],
    })
    expect(show(messages)).toEqual(["transcript:7:ok", "transcript:transcript:c:ok"])
  })

  it("lets a later entry with the same id replace an earlier one, since an edit appends again", () => {
    const messages = stitch({ transcripts: [transcript("a", "assistant", "...", at(1), "9"), transcript("b", "assistant", "the answer", at(1, 5), "9")] })
    expect(show(messages)).toEqual(["transcript:9:the answer"])
  })

  it("drops a message that the provider says is deleted, with its transcript copies", () => {
    const messages = stitch({
      provider: [provider("1", "kept", 1), provider("2", "secret", 2, false, { deleted: true }), provider("3", "gone", 3, false, { metadata: { dateSent: new Date(at(3)).toISOString(), deleted: true } })],
      transcripts: [transcript("a", "user", "secret", at(2), "2"), transcript("b", "user", "gone", at(3), "3"), transcript("c", "user", "kept", at(1), "1")],
    })
    expect(show(messages)).toEqual(["provider:1:kept"])
  })

  it.each([false, true])("honors deletion markers before duplicate IDs (reversed: %s)", (reversed) => {
    const history = [
      provider("2", "secret", 2),
      provider("3", "gone", 3),
      provider("2", "", 4, false, { deleted: true }),
      provider("3", "", 4, false, { metadata: { deleted: true } }),
    ]
    const messages = stitch({
      provider: [provider("1", "kept", 1), ...(reversed ? history.reverse() : history)],
      transcripts: [transcript("a", "user", "secret", at(2), "2"), transcript("b", "user", "gone", at(3), "3")],
    })
    expect(show(messages)).toEqual(["provider:1:kept"])
  })

  it("never sorts a reply before the message that it answers, whatever the source", () => {
    // One time for all of them, and the journal and the provider disagree about the order of their inputs.
    const invocation = { createdAt: new Date(at(1)).toISOString(), id: "run", prompt: "question", replies: ["answer"], status: "completed", updatedAt: new Date(at(1)).toISOString() }
    const messages = stitch({ invocations: [invocation] })
    expect(messages.map(message => message.role)).toEqual(["user", "assistant"])
    const mixed = stitch({
      provider: [provider("2", "answer", 1, true)],
      transcripts: [transcript("a", "user", "question", at(1), "1")],
    })
    expect(mixed.map(message => message.role)).toEqual(["user", "assistant"])
    // At one time and one role, the provider comes before the transcript and the journal.
    const sources = stitch({
      invocations: [{ createdAt: new Date(at(1)).toISOString(), id: "run", prompt: "from the journal", replies: [], sourceMessageId: "999", status: "failed", updatedAt: new Date(at(1)).toISOString() }],
      provider: [provider("1", "from the provider", 1)],
      transcripts: [transcript("a", "user", "from the transcript", at(1), "2")],
    })
    expect(sources.map(message => message.source)).toEqual(["provider", "transcript", "invocation"])
  })

  it("names the Invocation on its message and the replies up to the next person", () => {
    const messages = stitch({
      invocations: [
        { createdAt: new Date(at(1)).toISOString(), id: "run-1", replies: [], sourceMessageId: "1", status: "completed", updatedAt: new Date(at(2)).toISOString() },
        { createdAt: new Date(at(5)).toISOString(), id: "run-2", replies: [], sourceMessageId: "4", status: "failed", updatedAt: new Date(at(5)).toISOString() },
      ],
      provider: [provider("1", "q1", 1), provider("2", "...", 2, true), provider("3", "a1", 2, true), provider("4", "q2", 5)],
    })
    expect(messages.map(message => [message.id, message.invocationId])).toEqual([["1", "run-1"], ["2", "run-1"], ["3", "run-1"], ["4", "run-2"]])
  })

  it("adds the prompt and each reply that no message of the window holds", () => {
    const invocation = { createdAt: new Date(at(1)).toISOString(), id: "run-1", prompt: "question", replies: ["answer", "one more thing"], sourceMessageId: "1", status: "completed", updatedAt: new Date(at(2)).toISOString() }
    const messages = stitch({ invocations: [invocation] })
    expect(messages.map(message => `${message.role}/${message.source}:${message.text}`)).toEqual(["user/invocation:question", "assistant/invocation:answer", "assistant/invocation:one more thing"])
    // The provider holds the first reply, so the journal adds only the second: one message does not hide the other reply.
    const partial = stitch({ invocations: [invocation], provider: [provider("1", "question", 1), provider("2", "answer", 2, true)] })
    expect(partial.map(message => `${message.source}:${message.text}`)).toEqual(["provider:question", "provider:answer", "invocation:one more thing"])
    const full = stitch({ invocations: [{ ...invocation, replies: ["answer"] }], provider: [provider("1", "question", 1), provider("2", "answer", 2, true)] })
    expect(full.map(message => message.source)).toEqual(["provider", "provider"])
    expect(full.map(message => message.invocationId)).toEqual(["run-1", "run-1"])
  })

  it.each(["provider", "transcript"] as const)("matches parallel %s replies before assigning the next person's window", (source) => {
    const replies = ["answer to first", "answer to second"]
    const invocations = replies.map((reply, index) => ({
      createdAt: new Date(at(index + 1)).toISOString(), id: `run-${index + 1}`, replies: [reply],
      sourceMessageId: String(index + 1), status: "completed", updatedAt: new Date(at(index + 3)).toISOString(),
    }))
    for (const reversed of [false, true]) {
      const delivered = reversed ? [...replies].reverse() : replies
      const messages = stitch({
        invocations,
        provider: [provider("1", "first question", 1), provider("2", "second question", 2),
          ...(source === "provider" ? delivered.map((reply, index) => provider(`reply-${index}`, reply, 3, true)) : [])],
        transcripts: source === "transcript" ? delivered.map((reply, index) => transcript(`reply-${index}`, "assistant", reply, at(3), `reply-${index}`)) : [],
      })
      expect(messages).toHaveLength(4)
      expect(messages.filter(message => message.role === "assistant").map(message => [message.text, message.invocationId]))
        .toEqual(delivered.map(reply => [reply, `run-${replies.indexOf(reply) + 1}`]))
      expect(messages.some(message => message.source === "invocation")).toBe(false)
    }
  })

  it("keeps twelve journal-only replies in delivery order", () => {
    const replies = Array.from({ length: 12 }, (_, position) => `reply ${position}`)
    const invocation = { createdAt: new Date(at(1)).toISOString(), id: "run", prompt: "question", replies, status: "completed", updatedAt: new Date(at(2)).toISOString() }
    const messages = stitch({ invocations: [invocation] })
    expect(messages.map(message => message.text)).toEqual(["question", ...replies])
  })

  it.each(["provider", "transcript"] as const)("reserves exact %s replies before matching a shorter reply", (source) => {
    const replies = ["A complete answer", "A complete answer with detail"]
    const invocations = replies.map((reply, index) => ({
      createdAt: new Date(at(index + 1)).toISOString(), id: `run-${index + 1}`, replies: [reply],
      sourceMessageId: String(index + 1), status: "completed", updatedAt: new Date(at(3)).toISOString(),
    }))
    const messages = stitch({
      invocations,
      provider: [provider("1", "first question", 1), provider("2", "second question", 2),
        ...(source === "provider" ? [provider("reply", replies[1]!, 3, true)] : [])],
      transcripts: source === "transcript" ? [transcript("reply", "assistant", replies[1]!, at(3), "reply")] : [],
    })
    expect(messages).toHaveLength(4)
    expect(messages.filter(message => message.role === "assistant").map(message => [message.text, message.invocationId]))
      .toEqual([[replies[1], "run-2"], [replies[0], "run-1"]])
  })

  it.each((["provider", "transcript"] as const).flatMap(source => [1, 2, 3].map(count => ({ count, source }))))("does not infer provenance for $count identical overlapping $source replies", ({ count, source }) => {
    const invocations = [1, 2].map(index => ({
      createdAt: new Date(at(index)).toISOString(), id: `run-${index}`, replies: ["same answer"],
      sourceMessageId: String(index), status: "completed", updatedAt: new Date(at(3)).toISOString(),
    }))
    const ids = Array.from({ length: count }, (_, index) => `reply-${count - index}`)
    const messages = stitch({
      invocations,
      provider: [provider("1", "first question", 1), provider("2", "second question", 2),
        ...(source === "provider" ? ids.map(id => provider(id, "same answer", 3, true)) : [])],
      transcripts: source === "transcript" ? ids.map(id => transcript(id, "assistant", "same answer", at(3), id)) : [],
    })
    expect(messages).toHaveLength(2 + count)
    expect(messages.filter(message => message.role === "assistant").map(message => [message.id, message.text, message.invocationId, message.source]))
      .toEqual([...ids].sort().map(id => [id, "same answer", undefined, source]))
  })

  it("links identical replies when their delivery times distinguish the Invocations", () => {
    const messages = stitch({
      invocations: [1, 5].map(minute => ({
        createdAt: new Date(at(minute)).toISOString(), id: `run-${minute}`, replies: ["same answer"],
        sourceMessageId: String(minute), status: "completed", updatedAt: new Date(at(minute)).toISOString(),
      })),
      provider: [provider("1", "first question", 1), provider("reply-1", "same answer", 2, true),
        provider("5", "second question", 5), provider("reply-5", "same answer", 6, true)],
    })
    expect(messages.filter(message => message.role === "assistant").map(message => [message.id, message.invocationId]))
      .toEqual([["reply-1", "run-1"], ["reply-5", "run-5"]])
  })

  it("summarizes the people and the last message", () => {
    const messages = stitch({ provider: [provider("1", "q", 1), provider("2", "a", 9, true)] })
    expect(summarizeChannelConversation(messages)).toEqual({ lastMessageAt: new Date(at(9)).toISOString(), participants: ["Maxi"] })
  })
})

describe("stripChannelModelHeader", () => {
  it("removes the header that ViteHub adds for the model, and nothing else", () => {
    expect(stripChannelModelHeader("[Tue 2026-10-13 18:06:29 +02:00 · msg 109313 · photo AQAD]\nwhat is this?")).toBe("what is this?")
    expect(stripChannelModelHeader("[Tue 2026-10-13 18:06:29 +00:00]\nhi")).toBe("hi")
    // A tag that the person typed stays.
    expect(stripChannelModelHeader("[URGENT] call me")).toBe("[URGENT] call me")
    expect(stripChannelModelHeader("[2026-10-13] notes\nmore")).toBe("[2026-10-13] notes\nmore")
  })
})

describe("cursors", () => {
  const items = [{ id: "a", time: 1 }, { id: "b", time: 2 }, { id: "c", time: 2 }, { id: "d", time: 5 }]
  const key = (item: { id: string, time: number }) => ({ i: item.id, t: item.time })
  const after = (item: { time: number }, cursor: { t: number }) => item.time > cursor.t

  it("round-trips, and reads nothing from a value that is not one", () => {
    expect(decodeChannelCursor(encodeChannelCursor({ i: "a/b", t: 12 }))).toEqual({ i: "a/b", t: 12 })
    expect(encodeChannelCursor({ i: "x", t: 1 })).toMatch(/^[\w-]+$/)
    for (const value of ["", "nope", "e30", btoa("[1]"), btoa(JSON.stringify({ i: 1, t: "x" }))]) expect(decodeChannelCursor(value), value).toBeUndefined()
  })

  it("round-trips UTF-8 thread and message ids while accepting existing ASCII cursors", () => {
    const cursor = { i: "会話-😀", o: "1:0:返信-é", t: 12 }
    expect(decodeChannelCursor(encodeChannelCursor(cursor))).toEqual(cursor)
    expect(decodeChannelCursor(btoa(JSON.stringify({ i: "legacy", t: 1 })))).toEqual({ i: "legacy", t: 1 })
    expect(decodeChannelCursor(btoa(JSON.stringify({ i: "café", t: 1 })))).toEqual({ i: "café", t: 1 })
  })

  it("starts after the item that the cursor names, even when items arrived or left", () => {
    expect(pageAfterChannelCursor(items, { i: "b", t: 2 }, key, after).map(item => item.id)).toEqual(["c", "d"])
    // A new item at the start does not move the page.
    expect(pageAfterChannelCursor([{ id: "z", time: 0 }, ...items], { i: "b", t: 2 }, key, after).map(item => item.id)).toEqual(["c", "d"])
    // The named item slid out of the window: the page starts at the first later time.
    expect(pageAfterChannelCursor(items.filter(item => item.id !== "b"), { i: "b", t: 2 }, key, after).map(item => item.id)).toEqual(["d"])
    expect(pageAfterChannelCursor(items, undefined, key, after)).toHaveLength(4)
    expect(pageAfterChannelCursor(items, { i: "d", t: 5 }, key, after)).toEqual([])
  })
})

describe("the archive files and the Markdown export", () => {
  const data = Buffer.from("abc").toString("base64")
  const archive = {
    messages: [{
      attachments: [{ data, mimeType: "image/png", name: "../meal photo.png", type: "image" }, { name: "spec.pdf", unavailable: true, url: "https://cdn.example.com/spec.pdf" }],
      author: { fullName: "Maxi" },
      id: "1",
      invocationId: "run-1",
      metadata: { dateSent: "2026-06-10T12:01:00.000Z" },
      // A quoted message has attachments of its own, and so does the one it quotes.
      replyTo: { attachments: [{ data, name: "quoted.png", type: "image" }], id: "0", replyTo: { attachments: [{ data, name: "deep.png", type: "image" }], id: "-1" }, text: "earlier" },
      role: "user",
      text: "look\nat this",
    }],
  }

  it("moves the data of an attachment, at any depth, into numbered media files with safe names", () => {
    const { archive: files, media } = materializeChannelArchive(archive)
    expect(media.map(file => file.path)).toEqual(["media/0001-meal-photo.png", "media/0002-quoted.png", "media/0003-deep.png"])
    expect(media[0]).toEqual({ base64: data, mimeType: "image/png", path: "media/0001-meal-photo.png", size: 3 })
    const message = files.messages[0] as Record<string, any>
    expect(message.attachments).toEqual([
      { file: "media/0001-meal-photo.png", mimeType: "image/png", name: "../meal photo.png", type: "image" },
      { name: "spec.pdf", unavailable: true, url: "https://cdn.example.com/spec.pdf" },
    ])
    expect(message.replyTo.attachments[0]).toEqual({ file: "media/0002-quoted.png", name: "quoted.png", type: "image" })
    expect(message.replyTo.replyTo.attachments[0]).toEqual({ file: "media/0003-deep.png", name: "deep.png", type: "image" })
    expect(JSON.stringify(files)).not.toContain(data)
    // The Console puts the data back into one file, and gets the archive that it started from.
    expect(inlineChannelArchiveMedia(files, media)).toEqual({ messages: [{ ...archive.messages[0], attachments: [{ data, mimeType: "image/png", name: "../meal photo.png", type: "image" }, archive.messages[0]!.attachments[1]] }] })
  })

  it("renders author and time headers, fenced text, and links only for safe targets", () => {
    const { archive: files } = materializeChannelArchive(archive)
    const markdown = renderChannelConversationMarkdown({ agent: "support", channel: "telegram", exportedAt: "2026-10-25T10:00:00.000Z", messages: files.messages, provider: "telegram", retention: { durable: false, maxMessages: 100, ttlMs: 604_800_000 }, threadId: "telegram:1" })
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
      "```text",
      "look",
      "at this",
      "```",
      "",
      "- Attachment: [../meal photo.png](media/0001-meal-photo.png)".replace("[../meal photo.png]", "[..\\/meal photo.png]".replace("\\/", "/")),
      "- Attachment: [spec.pdf](https://cdn.example.com/spec.pdf) (not included)",
      "",
      "_Invocation run-1_",
      "",
    ].join("\n"))
  })

  it("escapes names and refuses links that are not http(s) or an export file", () => {
    const markdown = renderChannelConversationMarkdown({
      agent: "a`b", channel: "c", exportedAt: "2026-10-25T10:00:00.000Z",
      messages: [{ attachments: [{ name: "x](y)", url: "javascript:alert(1)" }, { name: "ok", url: "https://example.com/a (b).png" }, { file: "../../etc/passwd", name: "p" }, { name: "data", url: "data:text/html,<b>" }], author: { fullName: "# Boss *\nname" }, metadata: { dateSent: "2026-06-10T12:00:00.000Z" }, text: "hi" }],
      threadId: "t\n# injected",
    })
    expect(markdown.split("\n").filter(line => line.startsWith("#"))).toEqual(["# Conversation t \\# injected", "### \\# Boss \\* name · 2026-06-10 12:00:00 UTC"])
    expect(markdown).toContain("- Agent: a\\`b")
    expect(markdown).toContain("- Attachment: x\\]\\(y\\)\n")
    expect(markdown).toContain("- Attachment: [ok](https://example.com/a%20%28b%29.png)")
    expect(markdown).toContain("- Attachment: p\n")
    expect(markdown).toContain("- Attachment: data\n")
  })
})
