import { describe, expect, it, vi } from "vitest"

import { getTranscriptionResults, openRouterTranscriptionModel, streamTranscription, title, transcribe } from "../src/capabilities.ts"
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
    expect(audioExtensionFor("audio/mp3")).toBe("mp3")
    expect(audioExtensionFor("audio/unknown", "")).toBe("")
    expect(audioExtensionFor("audio/opus")).toBe("ogg")
    await expect(audioBytes({
      data: "data:audio/ogg;codecs=opus;base64,AQI=",
      mediaType: "audio/ogg",
      type: "audio",
    })).resolves.toEqual(new Uint8Array([1, 2]))
    await expect(audioBytes({
      data: "data:audio/ogg,%FF%D8%FF",
      mediaType: "audio/ogg",
      type: "audio",
    })).resolves.toEqual(new Uint8Array([255, 216, 255]))
  })

  it("sends OpenRouter transcription models namespaced model ids with normal JSON output", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      text: "voice transcript",
      usage: { seconds: 1.25 },
    }), {
      headers: { "content-type": "application/json", "x-generation-id": "gen-1" },
      status: 200,
    }))
    try {
      const model = openRouterTranscriptionModel({
        apiKey: () => "secret",
        model: "openai/gpt-4o-transcribe",
      })
      const result = await model.doGenerate({
        audio: new Uint8Array([1, 2, 3]),
        headers: { "x-vitehub": "agent" },
        mediaType: "audio/ogg; codecs=opus",
        providerOptions: {
          openrouter: {
            language: "en",
            provider: { order: ["openai"] },
            temperature: 0.2,
          },
        },
      })

      expect(request).toHaveBeenCalledOnce()
      const [url, init] = request.mock.calls[0] || []
      expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
      expect(init?.method).toBe("POST")
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-vitehub": "agent",
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        input_audio: { data: "AQID", format: "ogg" },
        language: "en",
        model: "openai/gpt-4o-transcribe",
        provider: { order: ["openai"] },
        response_format: "json",
        temperature: 0.2,
      })
      expect(result).toMatchObject({
        durationInSeconds: 1.25,
        response: { modelId: "openai/gpt-4o-transcribe" },
        text: "voice transcript",
      })
    }
    finally {
      request.mockRestore()
    }
  })

  it("exposes retryable OpenRouter provider failures to AI SDK transcription retries", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("null", { status: 503 }))
    try {
      const model = openRouterTranscriptionModel({
        apiKey: "secret",
        model: "openai/gpt-4o-transcribe",
      })

      await expect(model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: "audio/wav",
      })).rejects.toMatchObject({
        isRetryable: true,
        statusCode: 503,
      })
    }
    finally {
      request.mockRestore()
    }
  })

  it("normalizes OpenRouter response stream failures for AI SDK transcription retries", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset"))
      },
    }), { status: 200 }))
    try {
      const model = openRouterTranscriptionModel({
        apiKey: "secret",
        model: "openai/gpt-4o-transcribe",
      })

      await expect(model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: "audio/wav",
      })).rejects.toMatchObject({
        isRetryable: true,
        message: "OpenRouter transcription response failed.",
        statusCode: 200,
      })
    }
    finally {
      request.mockRestore()
    }
  })

  it("rejects unsupported OpenRouter transcription provider options", async () => {
    const model = openRouterTranscriptionModel({
      apiKey: "secret",
      model: "openai/gpt-4o-transcribe",
    })

    await expect(model.doGenerate({
      audio: new Uint8Array([1]),
      mediaType: "audio/wav",
      providerOptions: { openrouter: { unsupported: true } },
    })).rejects.toThrow("Unsupported OpenRouter transcription provider option: unsupported")
  })

  it("validates OpenRouter transcription credentials, provider options, and response shapes", async () => {
    const model = openRouterTranscriptionModel({
      apiKey: "secret",
      model: "openai/gpt-4o-transcribe",
    })
    const input = { audio: new Uint8Array([1]), mediaType: "audio/wav" }

    await expect(openRouterTranscriptionModel({
      apiKey: () => "",
      model: "openai/gpt-4o-transcribe",
    }).doGenerate(input)).rejects.toMatchObject({ name: "AI_LoadAPIKeyError" })
    await expect(model.doGenerate({ ...input, providerOptions: { openrouter: { language: "" } } }))
      .rejects.toThrow("language must be a non-empty string")
    await expect(model.doGenerate({ ...input, providerOptions: { openrouter: { temperature: -0.1 } } }))
      .rejects.toThrow("temperature must be between 0 and 1")
    await expect(model.doGenerate({ ...input, providerOptions: { openrouter: { temperature: 1.1 } } }))
      .rejects.toThrow("temperature must be between 0 and 1")
    await expect(model.doGenerate({ ...input, providerOptions: { openrouter: { provider: [] } } }))
      .rejects.toThrow("provider routing options must be an object")

    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 502 }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(new Response("null", { status: 200 }))
    try {
      await expect(model.doGenerate(input)).rejects.toMatchObject({
        isRetryable: true,
        responseBody: "unavailable",
        statusCode: 502,
      })
      await expect(model.doGenerate(input)).rejects.toMatchObject({ name: "AI_InvalidResponseDataError" })
      await expect(model.doGenerate(input)).rejects.toMatchObject({ name: "AI_InvalidResponseDataError" })
    }
    finally {
      request.mockRestore()
    }
  })

  it("accepts OpenRouter temperature boundaries and rejects unsupported audio formats", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ text: "ok" })))
    const model = openRouterTranscriptionModel({ apiKey: "secret", model: "openai/gpt-4o-transcribe" })
    try {
      await expect(model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: "audio/mp3",
        providerOptions: { openrouter: { temperature: 0 } },
      })).resolves.toMatchObject({ text: "ok" })
      await expect(model.doGenerate({
        audio: new Uint8Array([1]),
        mediaType: "audio/wav",
        providerOptions: { openrouter: { temperature: 1 } },
      })).resolves.toMatchObject({ text: "ok" })
      await expect(model.doGenerate({ audio: new Uint8Array([1]), mediaType: "audio/unknown" }))
        .rejects.toThrow("does not support audio/unknown")
      expect(request).toHaveBeenCalledTimes(2)
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
        input_audio: { format: "mp3" },
        temperature: 0,
      })
      expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ temperature: 1 })
    }
    finally {
      request.mockRestore()
    }
  })

  it("normalizes request failures while preserving OpenRouter transcription aborts", async () => {
    const model = openRouterTranscriptionModel({ apiKey: "secret", model: "openai/gpt-4o-transcribe" })
    const input = { audio: new Uint8Array([1]), mediaType: "audio/wav" }
    const connectionError = new Error("connection reset")
    const abortError = new DOMException("aborted", "AbortError")
    const controller = new AbortController()
    controller.abort(abortError)
    const request = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(connectionError)
      .mockRejectedValueOnce(abortError)
    try {
      await expect(model.doGenerate(input)).rejects.toMatchObject({
        cause: connectionError,
        isRetryable: true,
      })
      await expect(model.doGenerate({ ...input, abortSignal: controller.signal })).rejects.toBe(abortError)
    }
    finally {
      request.mockRestore()
    }
  })

  it("runs the OpenRouter model through the transcribe Capability contract", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "voice transcript" })))
    try {
      const capability = transcribe({
        model: openRouterTranscriptionModel({ apiKey: "secret", model: "openai/gpt-4o-transcribe" }),
      })
      const context = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: "AQI=", mediaType: "audio/wav", type: "audio" }],
          role: "user",
        }),
      ])

      await capability.input?.(context.context as never)

      expect(context.messages.at(-1)?.parts).toEqual([{ id: "text-0", text: "voice transcript", type: "text" }])
      expect(getTranscriptionResults(context.invocationContext)).toMatchObject([{ transcript: "voice transcript" }])
    }
    finally {
      request.mockRestore()
    }
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

  it("decodes Workflow audio data URLs before AI SDK transcription", async () => {
    const aiTranscribe = vi.fn(async () => ({ text: "voice transcript" }))
    vi.doMock("ai", () => ({
      createDownload: vi.fn(() => vi.fn()),
      transcribe: aiTranscribe,
    }))
    try {
      const capability = transcribe({ model: "mock-transcription-model" })
      const context = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: "data:audio/ogg;base64,T2dnUwECAw==", mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ])

      await capability.input?.(context.context as never)

      expect(aiTranscribe).toHaveBeenCalledWith(expect.objectContaining({
        audio: new Uint8Array([79, 103, 103, 83, 1, 2, 3]),
        model: "mock-transcription-model",
      }))

      const rawBase64Context = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: "T2dnUwECAw==", mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ])
      await capability.input?.(rawBase64Context.context as never)
      expect(aiTranscribe).toHaveBeenLastCalledWith(expect.objectContaining({ audio: "T2dnUwECAw==" }))

      const percentEncodedContext = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: "data:audio/ogg,%FF%D8%FF", mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ])
      await capability.input?.(percentEncodedContext.context as never)
      expect(aiTranscribe).toHaveBeenLastCalledWith(expect.objectContaining({
        audio: new Uint8Array([255, 216, 255]),
      }))

      const lazyDataUrlContext = createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ fetchData: () => "data:audio/ogg;base64,T2dnUwECAw==", mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ])
      await transcribe({ maxBytes: 7, model: "mock-transcription-model" }).input?.(lazyDataUrlContext.context as never)
      expect(aiTranscribe).toHaveBeenLastCalledWith(expect.objectContaining({
        audio: new Uint8Array([79, 103, 103, 83, 1, 2, 3]),
      }))

      const oversized = transcribe({ maxBytes: 6, model: "mock-transcription-model" })
      const decode = vi.spyOn(globalThis, "atob")
      await expect(oversized.input?.(createTranscriptionCapabilityContext([
        createMessage({
          parts: [{ data: "data:audio/ogg;base64,T2dnUwECAw==", mediaType: "audio/ogg", type: "audio" }],
          role: "user",
        }),
      ]).context as never)).rejects.toThrow("exceeds maxBytes")
      expect(decode).not.toHaveBeenCalled()
      decode.mockRestore()
      expect(aiTranscribe).toHaveBeenCalledTimes(4)
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it.each([
    [402, false, "TRANSCRIPTION_QUOTA_EXCEEDED", "[vitehub] Transcription provider quota is exhausted."],
    [408, true, "TRANSCRIPTION_PROVIDER_FAILED", "[vitehub] Transcription provider failed."],
    [409, true, "TRANSCRIPTION_PROVIDER_FAILED", "[vitehub] Transcription provider failed."],
  ] as const)("normalizes retry-exhausted HTTP %s transcription errors", async (status, isRetryable, code, message) => {
    const { APICallError, LoadAPIKeyError, RetryError } = await import("ai")
    const providerError = new APICallError({
      isRetryable,
      message: "Private provider failure.",
      requestBodyValues: {},
      responseBody: "private billing details",
      statusCode: status,
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
        code,
        message,
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
