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

function createTranscriptionCapabilityContext(messages: Array<ReturnType<typeof createMessage>>, writeFile = vi.fn()) {
  const store = new Map<string, unknown>()
  const invocationContext = {
    entries: () => store.entries(),
    get: <T = unknown>(key: string) => store.get(key) as T | undefined,
    has: (key: string) => store.has(key),
    set: (key: string, value: unknown) => store.set(key, value),
    toJSON: () => Object.fromEntries(store),
  }
  let currentMessages = messages

  return {
    context: {
      context: invocationContext,
      input: {
        get: () => ({ messages: currentMessages }),
        messages: () => currentMessages,
        set: vi.fn(),
        setMessages: (next: typeof messages) => {
          currentMessages = next
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
    },
    get messages() {
      return currentMessages
    },
    invocationContext,
    writeFile,
  }
}

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
    const execute = vi.fn(async () => "hola mundo")
    const capability = transcribe({
      execute,
      artifacts: {
        transcript: {
          path: ({ date, stem }) => `inbox/${date}/${stem}.md`,
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
    const context = createTranscriptionCapabilityContext([
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/opus", type: "audio" }],
        role: "user",
      }),
    ])

    await capability.input?.(context.context as never)

    expect(context.writeFile).toHaveBeenNthCalledWith(
      1,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
    expect(context.writeFile).toHaveBeenNthCalledWith(
      2,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
      "---\ncreated_at: 2026-05-28T10:50:04.000Z\naudio: inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg\n---\n\nhola mundo\n",
      { mediaType: "text/markdown" },
    )
    expect(getTranscriptionResults(context.invocationContext)).toEqual([{
      audioPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      createdAt: "2026-05-28T10:50:04.000Z",
      date: "2026-05-28",
      messageId: "telegram-4",
      stem: "2026-05-28T10-50-04Z-telegram-4",
      transcript: "hola mundo",
      transcriptPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
    }])
    expect(context.messages.at(-1)?.parts.at(-1)).toMatchObject({ text: "hola mundo", type: "text" })
  })

  it("can disable the audio artifact", async () => {
    const capability = transcribe({
      execute: vi.fn(async () => "hola mundo"),
      artifacts: {
        audio: false,
        transcript: {
          path: ({ date, stem }) => `inbox/${date}/${stem}.md`,
        },
      },
    })
    const context = createTranscriptionCapabilityContext([
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/opus", type: "audio" }],
        role: "user",
      }),
    ])

    await capability.input?.(context.context as never)

    expect(context.writeFile).toHaveBeenCalledOnce()
    expect(context.writeFile).toHaveBeenCalledWith(
      "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
      "hola mundo\n",
      { mediaType: "text/markdown" },
    )
    expect(getTranscriptionResults(context.invocationContext)[0]).toMatchObject({
      transcriptPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
    })
    expect(getTranscriptionResults(context.invocationContext)[0]?.audioPath).toBeUndefined()
  })

  it("can write the audio artifact to an explicit path", async () => {
    const capability = transcribe({
      execute: vi.fn(async () => "hola mundo"),
      artifacts: {
        audio: {
          path: ({ audioExtension, date, stem }) => `audio/${date}/${stem}.${audioExtension}`,
        },
        transcript: {
          path: ({ date, stem }) => `inbox/${date}/${stem}.md`,
          template: ({ audioPath, transcript }) => `${audioPath}\n${transcript}\n`,
        },
      },
    })
    const context = createTranscriptionCapabilityContext([
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/opus", type: "audio" }],
        role: "user",
      }),
    ])

    await capability.input?.(context.context as never)

    expect(context.writeFile).toHaveBeenNthCalledWith(
      1,
      "audio/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
    expect(context.writeFile).toHaveBeenNthCalledWith(
      2,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-telegram-4.md",
      "audio/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg\nhola mundo\n",
      { mediaType: "text/markdown" },
    )
  })

  it("can save the original audio without a transcript artifact", async () => {
    const capability = transcribe({
      execute: vi.fn(async () => "hola mundo"),
      artifacts: {
        audio: {
          path: ({ audioExtension, date, stem }) => `audio/${date}/${stem}.${audioExtension}`,
        },
        transcript: false,
      },
    })
    const context = createTranscriptionCapabilityContext([
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/opus", type: "audio" }],
        role: "user",
      }),
    ])

    await capability.input?.(context.context as never)

    expect(context.writeFile).toHaveBeenCalledOnce()
    expect(context.writeFile).toHaveBeenCalledWith(
      "audio/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
    expect(getTranscriptionResults(context.invocationContext)[0]).toMatchObject({
      audioPath: "audio/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      transcript: "hola mundo",
    })
    expect(getTranscriptionResults(context.invocationContext)[0]?.transcriptPath).toBeUndefined()
    expect(context.messages.at(-1)?.parts.at(-1)).toMatchObject({ text: "hola mundo", type: "text" })
  })

  it("rejects unsafe artifact paths", async () => {
    const capability = transcribe({
      execute: vi.fn(async () => "hola mundo"),
      artifacts: {
        transcript: {
          path: () => "/outside.md",
        },
      },
    })
    const context = createTranscriptionCapabilityContext([
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/opus", type: "audio" }],
        role: "user",
      }),
    ])

    await expect(capability.input?.(context.context as never)).rejects.toThrow("safe workspace path")
  })

})
