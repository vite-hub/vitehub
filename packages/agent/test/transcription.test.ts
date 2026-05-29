import { describe, expect, it, vi } from "vitest"

import { getTranscriptionResults, transcribe } from "../src/capabilities.ts"
import { audioBytes, audioExtensionFor } from "../src/capabilities/transcribe.ts"
import { createMessage, defineAgent, runAgent } from "../src/index.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("agent transcription", () => {
  it("normalizes audio extensions and bytes", async () => {
    expect(audioExtensionFor("audio/mpeg; codecs=mp3")).toBe("mp3")
    expect(audioExtensionFor("audio/opus")).toBe("ogg")
    await expect(audioBytes({
      data: "data:audio/ogg;codecs=opus;base64,AQI=",
      mediaType: "audio/ogg",
      type: "audio",
    })).resolves.toEqual(new Uint8Array([1, 2]))
  })

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

  it("resolves transcription options lazily", async () => {
    const execute = vi.fn(async () => "lazy transcript")
    const createOptions = vi.fn(() => ({ execute }))
    const agent = defineAgent({
      capabilities: [
        transcribe(createOptions),
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
    })).resolves.toMatchObject({ text: "lazy transcript" })
    expect(createOptions).toHaveBeenCalledOnce()
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

  it("writes audio and templated transcripts to a writable workspace", async () => {
    const writeFile = vi.fn()
    const execute = vi.fn(async () => "hola mundo")
    const capability = transcribe({
      execute,
      workspace: {
        directory: ({ date }) => `inbox/${date}`,
        transcript: {
          extension: ".md",
          template: ({ audioPath, createdAt, transcript }) => [
            "---",
            `created_at: ${createdAt}`,
            `audio: ${audioPath}`,
            "---",
            "",
            transcript,
            "",
          ].join("\n"),
        },
      },
    })
    const store = new Map<string, unknown>()
    const invocationContext = {
      entries: () => store.entries(),
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      has: (key: string) => store.has(key),
      set: (key: string, value: unknown) => store.set(key, value),
      toJSON: () => Object.fromEntries(store),
    }
    let messages = [
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/opus", type: "audio" }],
        role: "user",
      }),
    ]

    await capability.input?.({
      context: invocationContext,
      input: {
        get: () => ({ messages }),
        messages: () => messages,
        set: vi.fn(),
        setMessages: (next: typeof messages) => {
          messages = next
        },
      },
      run: { messageId: "telegram-4", runId: "run_1" },
      workspace: {
        diff: vi.fn(),
        fs: { writeFile },
        snapshot: vi.fn(),
        startSession: vi.fn(),
        tools: {},
      },
    } as never)

    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
      "---\ncreated_at: 2026-05-28T10:50:04.000Z\naudio: inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg\n---\n\nhola mundo\n",
      { mediaType: "text/markdown" },
    )
    expect(getTranscriptionResults(invocationContext)).toEqual([{
      audioPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      createdAt: "2026-05-28T10:50:04.000Z",
      date: "2026-05-28",
      messageId: "telegram-4",
      stem: "2026-05-28T10-50-04Z-telegram-4",
      transcript: "hola mundo",
      transcriptPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
    }])
    expect(messages.at(-1)?.parts.at(-1)).toMatchObject({ text: "hola mundo", type: "text" })
  })

})
