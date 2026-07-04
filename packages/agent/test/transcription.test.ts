import { describe, expect, it, vi } from "vitest"

import { getTranscriptionResults, transcribe } from "../src/capabilities.ts"
import { audioBytes, audioExtensionFor } from "../src/capabilities/transcribe.ts"
import { createMessage, defineAgent, runAgent, serializeMessages } from "../src/index.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

function createTranscriptionCapabilityContext(
  messages: Array<ReturnType<typeof createMessage>>,
  writeFile = vi.fn(),
  runMessageId = "telegram-4",
) {
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
      run: { messageId: runMessageId, runId: "run_1" },
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

  it("resolves lazy audio bytes with size limits", async () => {
    await expect(audioBytes({
      fetchData: () => new Uint8Array([1, 2, 3]),
      mediaType: "audio/ogg",
      size: 3,
      type: "audio",
    }, { maxBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]))

    await expect(audioBytes({
      fetchData: () => new Uint8Array([1, 2, 3, 4]),
      mediaType: "audio/ogg",
      type: "audio",
    }, { maxBytes: 3 })).rejects.toThrow("exceeds maxBytes")
  })

  it("reuses lazy audio bytes between transcription and audio artifacts", async () => {
    const fetchData = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const capability = transcribe({
      execute: async ({ audio }) => {
        await expect(audioBytes(audio, { maxBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]))
        return "hola mundo"
      },
      artifacts: {
        audio: {},
        transcript: false,
      },
      maxBytes: 3,
    })
    const context = createTranscriptionCapabilityContext([
      createMessage({
        createdAt: "2026-05-28T10:50:04.000Z",
        id: "msg_1",
        parts: [{ fetchData, mediaType: "audio/opus", size: 3, type: "audio" }],
        role: "user",
      }),
    ])

    await capability.input?.(context.context as never)

    expect(fetchData).toHaveBeenCalledOnce()
    expect(context.writeFile).toHaveBeenCalledWith(
      "audio/2026-05-28/2026-05-28T10-50-04Z-telegram-4.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
  })

  it("accepts audio message parts", () => {
    expect(createMessage({
      parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
      role: "user",
    }).parts).toEqual([
      { data: "AAAA", mediaType: "audio/wav", type: "audio" },
    ])

    expect(createMessage({
      parts: [{ fetchData: () => new Uint8Array([1]), mediaType: "audio/ogg", type: "audio" }],
      role: "user",
    }).parts[0]).toMatchObject({
      mediaType: "audio/ogg",
      type: "audio",
    })
  })

  it("rejects serializing lazy audio message parts", () => {
    const message = createMessage({
      parts: [{ fetchData: () => new Uint8Array([1]), mediaType: "audio/ogg", type: "audio" }],
      role: "user",
    })

    expect(() => serializeMessages([message])).toThrow("cannot serialize")
  })

  it("rejects invalid audio message parts", () => {
    expect(() => createMessage({
      parts: [{ data: "AAAA", mediaType: "text/plain", type: "audio" }],
      role: "user",
    })).toThrow("audio/* mediaType")

    expect(() => createMessage({
      parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio", url: "https://example.com/audio.wav" }],
      role: "user",
    })).toThrow("exactly one of data, fetchData, or url")
  })

  it("transcribes audio input with custom execution before agent execution", async () => {
    const execute = vi.fn(async () => "voice transcript")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        transcribe({ execute }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run(context) {
          const latest = context.messages.at(-1)
          return {
            text: latest?.parts
              .filter(part => part.type === "text")
              .map(part => part.text)
              .join(""),
          }
        } },
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
    expect(finish.mock.calls[0]![0].extensions.get("transcribe")).toEqual([{
      createdAt: expect.any(String),
      date: expect.any(String),
      messageId: expect.any(String),
      stem: expect.any(String),
      transcript: "voice transcript",
    }])
  })

  it("supports AI SDK v6 experimental_transcribe export", async () => {
    const experimentalTranscribe = vi.fn(async () => ({ text: "voice transcript" }))
    vi.doMock("ai", () => ({
      createDownload: vi.fn(() => vi.fn()),
      experimental_transcribe: experimentalTranscribe,
    }))
    try {
      const capability = transcribe({ model: "mock-transcription-model" })
      const context = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ])

      await capability.input?.(context.context as never)

      expect(experimentalTranscribe).toHaveBeenCalledWith(expect.objectContaining({
        audio: new Uint8Array([1, 2, 3]),
        model: "mock-transcription-model",
      }))
      expect(context.messages.at(-1)?.parts.at(-1)).toMatchObject({ text: "voice transcript", type: "text" })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("resolves transcription options lazily", async () => {
    const execute = vi.fn(async () => "lazy transcript")
    const createOptions = vi.fn(() => ({ execute }))
    const agent = defineAgent({
      capabilities: [
        transcribe(createOptions),
      ],
      driver: { run(context) {
          const latest = context.messages.at(-1)
          return {
            text: latest?.parts
              .filter(part => part.type === "text")
              .map(part => part.text)
              .join(""),
          }
        } },
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

  it("validates lazy transcription artifact workspace before transcribing", async () => {
    const execute = vi.fn(async () => "lazy transcript")
    const agent = defineAgent({
      capabilities: [
        transcribe(() => ({ artifacts: { transcript: {} }, execute })),
      ],
      driver: { run() {
          return { text: "done" }
        } },
    })

    await expect(runAgent(agent, runtime(), {
      messages: [
        createMessage({
          parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
          role: "user",
        }),
      ],
    })).rejects.toThrow("transcribe({ artifacts }) requires workspace.mode")
    expect(execute).not.toHaveBeenCalled()
  })

  it("separates appended transcripts from existing text", async () => {
    const agent = defineAgent({
      capabilities: [
        transcribe({ execute: vi.fn(async () => "review this") }),
      ],
      driver: { run(context) {
          const latest = context.messages.at(-1)
          return {
            text: latest?.parts
              .filter(part => part.type === "text")
              .map(part => part.text)
              .join(""),
          }
        } },
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

  it("sanitizes default artifact stems from platform message ids", async () => {
    const capability = transcribe({
      execute: vi.fn(async () => "hola mundo"),
      artifacts: {
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
    ], undefined, "152045426:10")

    await capability.input?.(context.context as never)

    expect(context.writeFile).toHaveBeenNthCalledWith(
      1,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-152045426-10.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
    expect(context.writeFile).toHaveBeenNthCalledWith(
      2,
      "inbox/2026-05-28/2026-05-28T10-50-04Z-152045426-10.md",
      "hola mundo\n",
      { mediaType: "text/markdown" },
    )
    expect(getTranscriptionResults(context.invocationContext)[0]).toMatchObject({
      audioPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-152045426-10.ogg",
      stem: "2026-05-28T10-50-04Z-152045426-10",
      transcriptPath: "inbox/2026-05-28/2026-05-28T10-50-04Z-152045426-10.md",
    })
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
