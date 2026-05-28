import { describe, expect, it, vi } from "vitest"

import { createMessage, defineAgent, runAgent, transcribe } from "@vitehub/agent"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("agent transcription", () => {
  it("accepts audio message parts", () => {
    expect(createMessage({
      parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
      role: "user",
    }).parts).toEqual([
      { data: "AAAA", mediaType: "audio/wav", type: "audio" },
    ])
  })

  it("rejects invalid audio message parts", () => {
    expect(() => createMessage({
      parts: [{ data: "AAAA", mediaType: "text/plain", type: "audio" }],
      role: "user",
    })).toThrow("audio/* mediaType")

    expect(() => createMessage({
      parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio", url: "https://example.com/audio.wav" }],
      role: "user",
    })).toThrow("exactly one of data or url")
  })

  it("transcribes audio input with custom execution before agent execution", async () => {
    const execute = vi.fn(async () => "voice transcript")
    const agent = defineAgent({
      capabilities: [
        transcribe({ execute }),
      ],
      run(context) {
        const latest = context.messages.at(-1)
        return {
          text: latest?.parts
            .filter(part => part.type === "text")
            .map(part => part.text)
            .join(""),
        }
      },
    })

    await expect(runAgent(agent, runtime(), {
      messages: [
        createMessage({
          parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
          role: "user",
        }),
      ],
    })).resolves.toMatchObject({ text: "voice transcript" })
    expect(execute).toHaveBeenCalledWith({
      audio: { data: "AAAA", mediaType: "audio/wav", type: "audio" },
    })
  })

  it("separates appended transcripts from existing text", async () => {
    const agent = defineAgent({
      capabilities: [
        transcribe({ execute: vi.fn(async () => "review this") }),
      ],
      run(context) {
        const latest = context.messages.at(-1)
        return {
          text: latest?.parts
            .filter(part => part.type === "text")
            .map(part => part.text)
            .join(""),
        }
      },
    })

    await expect(runAgent(agent, runtime(), {
      messages: [
        createMessage({
          parts: ["please", { data: "AAAA", mediaType: "audio/wav", type: "audio" }],
          role: "user",
        }),
      ],
    })).resolves.toMatchObject({ text: "please\nreview this" })
  })

})
