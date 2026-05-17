import { describe, expect, it } from "vitest"

import { toViteHubMessages } from "../src/agent-handoff.ts"

describe("chat agent handoff", () => {
  it("keeps text-only messages unchanged", () => {
    expect(toViteHubMessages([
      { id: "m1", text: "hello" } as never,
    ])).toMatchObject([
      {
        id: "m1",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
    ])
  })

  it("preserves audio attachments as ViteHub message parts", () => {
    expect(toViteHubMessages([
      {
        attachments: [
          { contentType: "audio/webm", data: "AAAA", id: "audio-1" },
        ],
        id: "m1",
        text: "listen",
      } as never,
    ])).toMatchObject([
      {
        parts: [
          { text: "listen", type: "text" },
          { data: "AAAA", id: "audio-1", mediaType: "audio/webm", type: "audio" },
        ],
      },
    ])
  })
})
