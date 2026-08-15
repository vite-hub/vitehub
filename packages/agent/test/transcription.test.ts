import { describe, expect, it, vi } from "vitest"

import { getTranscriptionResults, streamTranscription, title, transcribe } from "../src/capabilities.ts"
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
  it("normalizes streaming transcription events into reply text", async () => {
    const experimentalStreamTranscribe = vi.fn(() => ({
      fullStream: (async function* () {
        yield { delta: "hello ", type: "transcript-delta" as const }
        yield { text: "hello world", type: "transcript-final" as const }
      })(),
      text: Promise.resolve("hello world"),
    }))
    vi.doMock("ai", () => ({
      experimental_streamTranscribe: experimentalStreamTranscribe,
    }))
    try {
      const audio = new ReadableStream<Uint8Array>()
      const transcription = await streamTranscription({
        audio,
        inputAudioFormat: { rate: 24_000, type: "audio/pcm" },
        model: "openai/gpt-realtime-whisper",
      })
      let reply = ""
      for await (const chunk of transcription.textStream) reply += chunk

      expect(reply).toBe("hello world")
      await expect(transcription.text).resolves.toBe("hello world")
      expect(experimentalStreamTranscribe).toHaveBeenCalledWith({
        audio,
        inputAudioFormat: { rate: 24_000, type: "audio/pcm" },
        model: "openai/gpt-realtime-whisper",
      })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("uses the final streaming transcript when a provider emits no deltas", async () => {
    vi.doMock("ai", () => ({
      experimental_streamTranscribe: () => ({
        fullStream: (async function* () {
          yield { text: "hello", type: "transcript-partial" as const }
          yield { text: "hello world", type: "transcript-final" as const }
        })(),
        text: Promise.resolve("hello world"),
      }),
    }))
    try {
      const transcription = await streamTranscription({
        audio: new ReadableStream<Uint8Array>(),
        inputAudioFormat: { rate: 24_000, type: "audio/pcm" },
        model: "openai/gpt-realtime-whisper",
      })
      let reply = ""
      for await (const chunk of transcription.textStream) reply += chunk
      expect(reply).toBe("hello world")
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("handles the final text rejection when the provider stream fails", async () => {
    const error = new Error("provider failed")
    let rejectText!: (reason?: unknown) => void
    const text = new Promise<string>((_resolve, reject) => {
      rejectText = reject
    })
    const thenSpy = vi.spyOn(text, "then")
    vi.doMock("ai", () => ({
      experimental_streamTranscribe: () => ({
        fullStream: (async function* () {
          rejectText(error)
          yield { error, type: "error" as const }
        })(),
        text,
      }),
    }))
    try {
      const transcription = await streamTranscription({
        audio: new ReadableStream<Uint8Array>(),
        inputAudioFormat: { rate: 24_000, type: "audio/pcm" },
        model: "openai/gpt-realtime-whisper",
      })
      await expect(async () => {
        for await (const _chunk of transcription.textStream) {}
      }).rejects.toThrow(error)
      expect(thenSpy).toHaveBeenCalledOnce()
      await expect(transcription.text).rejects.toThrow(error)
    }
    finally {
      vi.doUnmock("ai")
    }
  })

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

  it("cancels oversized and erroring audio responses and releases readers", async () => {
    const headerCancel = vi.fn()
    const headerOversized = new ReadableStream<Uint8Array>({ cancel: headerCancel })
    const cancel = vi.fn()
    const oversized = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4]))
      },
    })
    const readError = new Error("audio stream failed")
    const erroring = new ReadableStream<Uint8Array>({
      pull() {
        throw readError
      },
    })
    const successful = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(headerOversized, { headers: { "content-length": "4" } }))
      .mockResolvedValueOnce(new Response(oversized))
      .mockResolvedValueOnce(new Response(erroring))
      .mockResolvedValueOnce(new Response(successful))
    const audio = { mediaType: "audio/ogg", type: "audio" as const, url: "https://example.com/audio.ogg" }

    try {
      await expect(audioBytes(audio, { maxBytes: 3 })).rejects.toThrow("exceeds maxBytes")
      expect(headerCancel).toHaveBeenCalledOnce()

      await expect(audioBytes(audio, { maxBytes: 3 })).rejects.toThrow("exceeds maxBytes")
      expect(cancel).toHaveBeenCalledOnce()
      expect(oversized.locked).toBe(false)

      await expect(audioBytes(audio, { maxBytes: 3 })).rejects.toBe(readError)
      expect(erroring.locked).toBe(false)

      await expect(audioBytes(audio, { maxBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]))
      expect(successful.locked).toBe(false)
    }
    finally {
      fetch.mockRestore()
    }
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

  it("accepts typed attachment message parts and preserves multiple handles", () => {
    expect(createMessage({
      parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
      role: "user",
    }).parts).toEqual([
      { data: "AAAA", mediaType: "audio/wav", type: "audio" },
    ])

    expect(createMessage({
      parts: [{ fetchData: () => new Uint8Array([1]), fetchMetadata: { fileId: "audio-1" }, mediaType: "audio/ogg", type: "audio", url: "https://example.com/audio.ogg" }],
      role: "user",
    }).parts[0]).toMatchObject({
      fetchData: expect.any(Function),
      fetchMetadata: { fileId: "audio-1" },
      mediaType: "audio/ogg",
      type: "audio",
      url: "https://example.com/audio.ogg",
    })

    expect(createMessage({
      parts: [
        { mediaType: "image/png", type: "image", url: "https://example.com/photo.png" },
        { mediaType: "application/pdf", name: "report.pdf", type: "file", url: "https://example.com/report.pdf" },
      ],
      role: "user",
    }).parts).toMatchObject([
      { type: "image", url: "https://example.com/photo.png" },
      { name: "report.pdf", type: "file", url: "https://example.com/report.pdf" },
    ])
  })

  it("rejects serializing lazy attachment message parts", () => {
    const message = createMessage({
      parts: [{ fetchData: () => new Uint8Array([1]), mediaType: "audio/ogg", type: "audio" }],
      role: "user",
    })

    expect(() => serializeMessages([message])).toThrow("cannot serialize")

    expect(() => serializeMessages([createMessage({
      parts: [{ fetchData: () => new Uint8Array([1]), mediaType: "image/png", type: "image" }],
      role: "user",
    })])).toThrow("cannot serialize")

    expect(() => serializeMessages([createMessage({
      parts: [{ data: new Uint8Array([1]), mediaType: "image/png", type: "image" }],
      role: "user",
    })])).toThrow("cannot serialize binary data")
  })

  it("rejects invalid audio message parts", () => {
    expect(() => createMessage({
      parts: [{ data: "AAAA", mediaType: "text/plain", type: "audio" }],
      role: "user",
    })).toThrow("audio/* mediaType")

    expect(() => createMessage({
      parts: [{ mediaType: "audio/wav", type: "audio" }],
      role: "user",
    })).toThrow("requires data, fetchData, or url")

    expect(() => createMessage({
      parts: [{ mediaType: "application/octet-stream", type: "image", url: "https://example.com/image" }],
      role: "user",
    })).toThrow("image/* mediaType")

    expect(() => createMessage({
      parts: [{ data: new Uint8Array(), mediaType: "audio/wav", type: "audio" }],
      role: "user",
    })).toThrow("requires data, fetchData, or url")
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
    expect(finish.mock.calls[0]![0].input.messages.at(-1)?.parts).toEqual([
      { id: "text-0", text: "voice transcript", type: "text" },
    ])
    expect(finish.mock.calls[0]![0].extensions.get("transcribe")).toEqual([{
      createdAt: expect.any(String),
      date: expect.any(String),
      messageId: expect.any(String),
      stem: expect.any(String),
      transcript: "voice transcript",
    }])
  })

  it("generates titles from prepared audio transcripts", async () => {
    const executeTitle = vi.fn(({ text }) => `Title: ${text}`)
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        title({ execute: executeTitle }),
        transcribe({ execute: vi.fn(async () => "voice transcript") }),
      ],
      driver: { run: () => ({ text: "agent reply" }) },
      hooks: {
        "agent:finish": finish,
      },
    })

    await runAgent(agent, runtime(), {
      messages: [createMessage({
        parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
        role: "user",
      })],
    })

    expect(executeTitle).toHaveBeenCalledWith(expect.objectContaining({
      source: "input",
      text: "voice transcript",
    }))
    expect(finish.mock.calls[0]![0].extensions.get("title")).toEqual({ title: "Title: voice transcript" })
  })

  it("combines authored text and audio transcripts before generating a title", async () => {
    const executeTitle = vi.fn(({ text }) => `Title: ${text}`)
    const agent = defineAgent({
      capabilities: [
        title({ execute: executeTitle }),
        transcribe({ execute: vi.fn(async () => "voice transcript") }),
      ],
      driver: { run: () => ({ text: "agent reply" }) },
      hooks: {
        "agent:finish": vi.fn(),
      },
    })

    await runAgent(agent, runtime(), {
      messages: [createMessage({
        parts: ["authored context", { data: "AAAA", mediaType: "audio/wav", type: "audio" }],
        role: "user",
      })],
    })

    expect(executeTitle).toHaveBeenCalledOnce()
    expect(executeTitle).toHaveBeenCalledWith(expect.objectContaining({
      source: "input",
      text: "authored context\nvoice transcript",
    }))
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

  it("normalizes exhausted transcription quota errors", async () => {
    const { APICallError, LoadAPIKeyError, RetryError } = await import("ai")
    const providerError = new APICallError({
      isRetryable: false,
      message: "You have no credits remaining.",
      requestBodyValues: {},
      responseBody: "private billing details",
      statusCode: 402,
      url: "https://provider.example/audio/transcriptions",
    })
    const retryError = new RetryError({
      errors: [providerError],
      message: "Failed after 3 attempts.",
      reason: "maxRetriesExceeded",
    })
    vi.doMock("ai", () => ({
      APICallError,
      LoadAPIKeyError,
      RetryError,
      createDownload: vi.fn(() => vi.fn()),
      transcribe: vi.fn(async () => { throw retryError }),
    }))
    try {
      const capability = transcribe({ model: "mock-transcription-model" })
      const context = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: new Uint8Array([1, 2, 3]), mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ])

      const error = await Promise.resolve(capability.input?.(context.context as never)).catch((error: unknown) => error)

      expect(error).toMatchObject({
        cause: retryError,
        code: "TRANSCRIPTION_QUOTA_EXCEEDED",
        message: "[vitehub] Transcription provider quota is exhausted.",
      })
      expect(JSON.stringify(error)).not.toContain("private billing details")
      expect(context.messages.at(-1)?.parts).toHaveLength(1)
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

  it("writes markdown artifacts under a configured directory", async () => {
    const capability = transcribe({
      execute: vi.fn(async () => "hola mundo"),
      artifacts: {
        directory: "inputs/telegram-audio",
        transcript: { format: "markdown" },
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
      "inputs/telegram-audio/2026-05-28T10-50-04Z-telegram-4.ogg",
      new Uint8Array([1, 2, 3]),
      { mediaType: "audio/opus" },
    )
    expect(context.writeFile).toHaveBeenNthCalledWith(
      2,
      "inputs/telegram-audio/2026-05-28T10-50-04Z-telegram-4.md",
      "---\ncreated_at: 2026-05-28T10:50:04.000Z\naudio: inputs/telegram-audio/2026-05-28T10-50-04Z-telegram-4.ogg\n---\n\nhola mundo\n",
      { mediaType: "text/markdown" },
    )
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
