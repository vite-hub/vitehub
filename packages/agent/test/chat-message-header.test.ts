import { describe, expect, it } from "vitest"

import { transformChannelTextStream } from "../src/internal/channel-citations.ts"
import {
  createChatMetadataEchoFilter,
  formatChatHeaderTime,
  formatChatMessageHeader,
  formatChatReplyLine,
  stripEchoedChatMessageMetadata,
} from "../src/internal/chat-message-header.ts"

const time = Date.UTC(2026, 10, 3, 12, 5, 22)
const header = formatChatMessageHeader([formatChatHeaderTime(time, "Europe/Madrid"), "msg 812", "photo AgADxyz"])
const replyLine = formatChatReplyLine({
  author: "your",
  media: ["photo attached below"],
  messageId: "811",
  quote: "\"Should I log the nachos?\"",
  time: formatChatHeaderTime(time, "Europe/Madrid", true),
})

async function streamed(chunks: string[]) {
  let text = ""
  for await (const chunk of transformChannelTextStream((async function* () {
    yield* chunks
  })(), createChatMetadataEchoFilter)) text += chunk
  return text
}

describe("echoed chat message metadata", () => {
  it("keeps a plain answer", () => {
    expect(stripEchoedChatMessageMetadata("Logged 300 kcal.\n\nTotal today: 1200 kcal.")).toBe("Logged 300 kcal.\n\nTotal today: 1200 kcal.")
  })

  it("removes an echoed header line", () => {
    expect(header).toBe("[Tue 2026-11-03 13:05:22 +01:00 · msg 812 · photo AgADxyz]")
    expect(stripEchoedChatMessageMetadata(`${header}\nLogged 300 kcal.`)).toBe("Logged 300 kcal.")
    expect(stripEchoedChatMessageMetadata(`${header} Logged 300 kcal.`)).toBe("Logged 300 kcal.")
  })

  it("removes headers in every format the route writes", () => {
    for (const fields of [
      [formatChatHeaderTime(time, "UTC"), "msg 812"],
      [formatChatHeaderTime(time, "America/New_York"), "msg 812", "from Max (id 42)", "voice (not shown)", "edited"],
      [formatChatHeaderTime(time, "Asia/Kolkata")],
      ["msg 812"],
    ]) {
      expect(stripEchoedChatMessageMetadata(`${formatChatMessageHeader(fields)}\nOk`)).toBe("Ok")
    }
  })

  it("removes an echoed reply line and the header before it", () => {
    expect(replyLine).toBe("↪ replying to your msg 811 (Tue 13:05): \"Should I log the nachos?\" · photo attached below")
    expect(stripEchoedChatMessageMetadata(`${replyLine}\nBoth.`)).toBe("Both.")
    expect(stripEchoedChatMessageMetadata(`${header}\n${replyLine}\n\nBoth.`)).toBe("Both.")
    expect(stripEchoedChatMessageMetadata(`${header}\n${formatChatReplyLine({ author: "Max's", media: [], messageId: "unknown" })}\nBoth.`)).toBe("Both.")
  })

  it("keeps answers appended to echoed reply lines", async () => {
    for (const line of [
      formatChatReplyLine({ author: "your", media: [], messageId: "811", quote: "\"...\"" }),
      replyLine,
      formatChatReplyLine({ author: "Max's", media: ["photo AgADxyz attached below", "voice (not shown)"], messageId: "811", quote: "(shown above)" }),
      formatChatReplyLine({ author: "bot", media: [], messageId: "811" }),
    ]) {
      expect(stripEchoedChatMessageMetadata(line)).toBe("")
      expect(stripEchoedChatMessageMetadata(`${line} Both.`)).toBe("Both.")
      expect(stripEchoedChatMessageMetadata(`${header}\n${line} Both.\nMore.`)).toBe("Both.\nMore.")
      expect(await streamed([...`${header}\n${line} Both.`])).toBe("Both.")
      expect(await streamed([`${line} Both.\nMore.`])).toBe("Both.\nMore.")
    }
  })

  it("keeps reply lines when quote boundaries are ambiguous", async () => {
    for (const line of [
      "↪ replying to your msg 811: \"Log the \"nachos\"?\" Both.",
      "↪ replying to your msg 811: \"Log the \"nachos\"?\" John's msg 42 is next.",
      "↪ replying to your msg 811: \"Log it?\" Both. Say \"yes\".",
      "↪ replying to your msg 811: \"unfinished quote Both.",
    ]) {
      expect(stripEchoedChatMessageMetadata(`${header}\n${line}`)).toBe(line)
      expect(await streamed([...`${header}\n${line}`])).toBe(line)
    }
  })

  it("keeps text that only looks similar", () => {
    for (const text of [
      "[Tue 2026-11-03] Lunch: 300 kcal",
      "[msg] is not a header",
      "[Docs](https://vitehub.dev) explain headers.",
      "  [Tue 2026-11-03 13:05:22 +01:00 · msg 812]\nindented",
      "↪ replying to everyone at once",
      `Your message ${header} had a photo.`,
      `Logged.\n${header}`,
      `Logged.\n${replyLine}`,
    ]) {
      expect(stripEchoedChatMessageMetadata(text)).toBe(text)
    }
  })

  it("removes the same lines from a stream, whatever the chunk boundaries", async () => {
    const text = `${header}\n${replyLine}\n\nLogged 300 kcal.`
    expect(await streamed([text])).toBe("Logged 300 kcal.")
    expect(await streamed([...text])).toBe("Logged 300 kcal.")
    expect(await streamed(["[Docs", "](https://vitehub.dev)\n", "more"])).toBe("[Docs](https://vitehub.dev)\nmore")
    expect(await streamed([...`${header}`])).toBe("")
  })

  it("streams a plain answer without holding it back", () => {
    const filter = createChatMetadataEchoFilter()
    expect(filter("Logged")).toBe("Logged")
    expect(filter(" 300 kcal.")).toBe(" 300 kcal.")
  })
})
