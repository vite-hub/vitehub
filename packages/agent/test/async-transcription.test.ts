import { describe, expect, it, vi } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import {
  createTranscription,
  elevenLabsScribe,
} from "../src/capabilities.ts"
import { transcriptionError } from "../src/capabilities/transcription.ts"

import type {
  TranscriptionDriver,
  TranscriptionErrorCode,
  TranscriptionErrorDetails,
  TranscriptionSubmitInput,
} from "../src/capabilities.ts"

type TranscriptionFailure = ViteHubError<TranscriptionErrorCode, TranscriptionErrorDetails>

function fixtureDriver(overrides: Partial<TranscriptionDriver> = {}): TranscriptionDriver {
  return {
    name: "fixture",
    receive: vi.fn(async () => ({
      id: "operation-1",
      status: "completed" as const,
      transcript: { text: "Hello" },
    })),
    submit: vi.fn(async () => ({ id: "operation-1" })),
    ...overrides,
  }
}

describe("createTranscription", () => {
  it("normalizes remote submissions and provider completions", async () => {
    const driver = fixtureDriver()
    const client = createTranscription({ driver })

    await expect(client.submit({
      metadata: { attemptNonce: "attempt-1", jobId: "job-1" },
      source: { mediaType: "audio/mpeg", name: "meeting.mp3", url: "https://private.example/audio.mp3?signature=1" },
    })).resolves.toEqual({ id: "operation-1", provider: "fixture", status: "submitted" })
    expect(driver.submit).toHaveBeenCalledWith({
      metadata: { attemptNonce: "attempt-1", jobId: "job-1" },
      source: { mediaType: "audio/mpeg", name: "meeting.mp3", url: "https://private.example/audio.mp3?signature=1" },
    })

    await expect(client.receive({ provider: "payload" })).resolves.toEqual({
      id: "operation-1",
      provider: "fixture",
      status: "completed",
      transcript: { text: "Hello" },
    })
  })

  it.each([
    [{ source: undefined }, "TRANSCRIPTION_INVALID_REQUEST", "source must be an object"],
    [{ source: { url: "audio.mp3" } }, "TRANSCRIPTION_INVALID_REQUEST", "Invalid URL"],
    [{ source: { url: "file:///audio.mp3" } }, "TRANSCRIPTION_INVALID_REQUEST", "HTTP or HTTPS"],
    [{ metadata: [], source: { url: "https://example.com/audio.mp3" } }, "TRANSCRIPTION_INVALID_REQUEST", "metadata must be an object"],
  ] as const)("rejects an invalid submission before calling the driver", async (input, code, diagnostic) => {
    const driver = fixtureDriver()
    const client = createTranscription({ driver })

    const error = await client.submit(input as TranscriptionSubmitInput).then(() => undefined, cause => cause as TranscriptionFailure)
    expect(error).toMatchObject({
      code,
      message: code === "TRANSCRIPTION_INVALID_REQUEST"
        ? "[vitehub] Transcription request is invalid."
        : "[vitehub] Transcription provider returned an invalid payload.",
    })
    expect(error?.cause).toMatchObject({ message: expect.stringContaining(diagnostic) })
    expect(JSON.stringify(error)).not.toContain(diagnostic)
    expect(driver.submit).not.toHaveBeenCalled()
  })

  it("preserves custom driver failures exactly", async () => {
    const cause = new Error("secret provider response")
    const client = createTranscription({ driver: fixtureDriver({ submit: vi.fn(async () => { throw cause }) }) })

    await expect(client.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toBe(cause)
  })

  it("normalizes unreadable resolved driver submissions", async () => {
    const cause = new Error("secret submission getter")
    const submission = Object.defineProperty({}, "id", { get: () => { throw cause } })
    const client = createTranscription({ driver: fixtureDriver({ submit: vi.fn(async () => submission as never) }) })

    const error = await client.submit({ source: { url: "https://example.com/audio.mp3" } }).then(() => undefined, error => error as TranscriptionFailure)
    expect(error).toMatchObject({ cause, code: "TRANSCRIPTION_INVALID_PAYLOAD" })
    expect(JSON.stringify(error)).not.toContain("secret submission getter")
  })

  it.each(["id", "metadata", "status", "transcript"] as const)("normalizes unreadable completion %s getters", async (field) => {
    const cause = new Error(`secret ${field} getter`)
    const transcript = field === "transcript"
      ? Object.defineProperty({}, "text", { get: () => { throw cause } })
      : { text: "ok" }
    const completion = { id: "operation-1", metadata: {}, status: "completed", transcript }
    if (field !== "transcript") Object.defineProperty(completion, field, { get: () => { throw cause } })
    const client = createTranscription({ driver: fixtureDriver({ receive: vi.fn(async () => completion as never) }) })

    const error = await client.receive({}).then(() => undefined, error => error as TranscriptionFailure)
    expect(error).toMatchObject({ cause, code: "TRANSCRIPTION_INVALID_PAYLOAD" })
    expect(JSON.stringify(error)).not.toContain(`secret ${field} getter`)
  })

  it("rejects invalid driver results", async () => {
    const invalidSubmission = createTranscription({ driver: fixtureDriver({ submit: vi.fn(async () => ({ id: "" })) }) })
    const invalidCompletion = createTranscription({ driver: fixtureDriver({ receive: vi.fn(async () => ({ id: "operation-1", status: "queued" } as never)) }) })

    await expect(invalidSubmission.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toMatchObject({
      code: "TRANSCRIPTION_INVALID_PAYLOAD",
      message: "[vitehub] Transcription provider returned an invalid payload.",
    })
    await expect(invalidCompletion.receive({})).rejects.toMatchObject({
      code: "TRANSCRIPTION_INVALID_PAYLOAD",
      message: "[vitehub] Transcription provider returned an invalid payload.",
    })
  })

  it("rejects hostile provider identifiers before they reach public details", () => {
    expect(() => createTranscription({ driver: fixtureDriver({ name: "https://user:token@example.com" }) })).toThrow(TypeError)
    expect(() => transcriptionError("CUSTOM" as never)).toThrow(TypeError)
    expect(transcriptionError("TRANSCRIPTION_PROVIDER_FAILED", {
      provider: "https://user:token@example.com",
    }).toJSON()).toEqual({
      code: "TRANSCRIPTION_PROVIDER_FAILED",
      message: "[vitehub] Transcription provider failed.",
      name: "ViteHubError",
    })
  })

  it("handles hostile error constructor options", () => {
    const secret = "https://user:token@example.com/private"
    const options = new Proxy({}, {
      get() {
        throw new Error(secret)
      },
    })
    const error = transcriptionError("TRANSCRIPTION_PROVIDER_FAILED", options as never)

    expect(error.toJSON()).toEqual({
      code: "TRANSCRIPTION_PROVIDER_FAILED",
      message: "[vitehub] Transcription provider failed.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it.each([
    "TRANSCRIPTION_AUTHENTICATION_FAILED",
    "TRANSCRIPTION_INVALID_PAYLOAD",
    "TRANSCRIPTION_INVALID_REQUEST",
    "TRANSCRIPTION_NETWORK_FAILED",
    "TRANSCRIPTION_PROVIDER_FAILED",
    "TRANSCRIPTION_RATE_LIMITED",
  ] as const)("serializes code %s", (code) => {
    const error = transcriptionError(code)
    expect(error.toJSON()).toEqual({
      code,
      message: error.message,
      name: "ViteHubError",
    })
  })
})

describe("elevenLabsScribe", () => {
  it("submits a Summary-shaped private URL and normalizes its correlated callback", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get("model_id")).toBe("scribe_v2")
      expect(form.get("source_url")).toBe("https://private.example/jobs/job-1/audio.mp3?signature=1")
      expect(form.get("webhook")).toBe("true")
      expect(form.get("webhook_id")).toBe("webhook-1")
      expect(form.get("webhook_metadata")).toBe(JSON.stringify({
        attempt_nonce: "attempt-1",
        hook_token: "hook-1",
        job_id: "job-1",
      }))
      expect(form.get("diarize")).toBe("true")
      expect(form.get("timestamps_granularity")).toBe("word")
      expect(form.get("tag_audio_events")).toBe("true")
      return Response.json({ request_id: "request-1" })
    })
    const client = createTranscription({
      driver: elevenLabsScribe({
        apiKey: () => "secret",
        diarize: true,
        fetch: request,
        tagAudioEvents: true,
        timestampsGranularity: "word",
        webhookId: "webhook-1",
      }),
    })

    await expect(client.submit({
      metadata: { attempt_nonce: "attempt-1", hook_token: "hook-1", job_id: "job-1" },
      source: { url: "https://private.example/jobs/job-1/audio.mp3?signature=1" },
    })).resolves.toEqual({ id: "request-1", provider: "elevenlabs", status: "submitted" })
    expect(request).toHaveBeenCalledWith("https://api.elevenlabs.io/v1/speech-to-text", expect.objectContaining({
      headers: { "xi-api-key": "secret" },
      method: "POST",
    }))

    await expect(client.receive({
      data: {
        request_id: "request-1",
        transcription: {
          language_code: "th",
          language_probability: 0.98,
          text: "สวัสดี",
          words: [
            { channel_index: 0, end: 0.5, speaker_id: "speaker_0", start: 0, text: "สวัสดี", type: "word" },
            { end: 0.6, start: 0.5, text: " ", type: "spacing" },
          ],
        },
        webhook_metadata: { attempt_nonce: "attempt-1", hook_token: "hook-1", job_id: "job-1" },
      },
      type: "speech_to_text_transcription",
    })).resolves.toEqual({
      id: "request-1",
      metadata: { attempt_nonce: "attempt-1", hook_token: "hook-1", job_id: "job-1" },
      provider: "elevenlabs",
      status: "completed",
      transcript: {
        language: "th",
        languageConfidence: 0.98,
        text: "สวัสดี",
        words: [
          { channel: 0, end: 0.5, speaker: "speaker_0", start: 0, text: "สวัสดี", type: "word" },
          { end: 0.6, start: 0.5, text: " ", type: "spacing" },
        ],
      },
    })
  })

  it("normalizes provider completion failures for workflow handling", async () => {
    const client = createTranscription({
      driver: elevenLabsScribe({ apiKey: "secret", fetch: vi.fn(), webhookId: "webhook-1" }),
    })

    const completion = await client.receive({
      data: { error: "Unsupported audio", request_id: "request-2", webhook_metadata: { job_id: "job-1" } },
      type: "speech_to_text_transcription",
    })
    expect(completion).toMatchObject({
      error: {
        code: "TRANSCRIPTION_PROVIDER_FAILED",
        details: { provider: "elevenlabs" },
        message: "[vitehub] Transcription provider failed.",
      },
      id: "request-2",
      metadata: { job_id: "job-1" },
      provider: "elevenlabs",
      status: "failed",
    })
    expect(completion.status === "failed" && completion.error.toJSON()).toEqual({
      code: "TRANSCRIPTION_PROVIDER_FAILED",
      details: { provider: "elevenlabs" },
      message: "[vitehub] Transcription provider failed.",
      name: "ViteHubError",
    })
    expect(completion.status === "failed" && (completion.error.cause as Error).message).toBe("Unsupported audio")
    expect(JSON.stringify(completion)).not.toContain("Unsupported audio")
  })

  it("does not copy extra driver fields into public completions", async () => {
    const driver = fixtureDriver({
      receive: vi.fn(async () => ({
        error: "private failure",
        id: "operation-1",
        rawProviderBody: "private body",
        status: "failed",
      } as never)),
    })

    const completion = await createTranscription({ driver }).receive({})
    expect(completion).not.toHaveProperty("rawProviderBody")
    expect(JSON.stringify(completion)).not.toContain("private body")
  })

  it("does not copy extra driver fields into public transcripts", async () => {
    const driver = fixtureDriver({
      receive: vi.fn(async () => ({
        id: "operation-1",
        status: "completed",
        transcript: {
          rawProviderBody: "private transcript body",
          text: "Hello",
          words: [{ rawProviderWord: "private word body", text: "Hello", type: "word" }],
        },
      } as never)),
    })

    const completion = await createTranscription({ driver }).receive({})
    expect(completion).toMatchObject({ transcript: { text: "Hello", words: [{ text: "Hello", type: "word" }] } })
    expect(JSON.stringify(completion)).not.toMatch(/private transcript body|private word body/)
  })

  it("normalizes invalid ElevenLabs metadata serialization", async () => {
    const client = createTranscription({
      driver: elevenLabsScribe({ apiKey: "secret", fetch: vi.fn(), webhookId: "webhook-1" }),
    })

    const metadata: Record<string, unknown> = {}
    metadata.circular = metadata
    const error = await client.submit({
      metadata,
      source: { url: "https://example.com/audio.mp3" },
    }).then(() => undefined, cause => cause as TranscriptionFailure)

    expect(error).toMatchObject({
      code: "TRANSCRIPTION_INVALID_REQUEST",
      details: { provider: "elevenlabs" },
    })
    expect(JSON.stringify(error)).not.toContain("circular")
  })

  it("normalizes malformed ElevenLabs transcript words", async () => {
    const client = createTranscription({
      driver: elevenLabsScribe({ apiKey: "secret", fetch: vi.fn(), webhookId: "webhook-1" }),
    })

    await expect(client.receive({
      data: { request_id: "request-1", transcription: { text: "Hello", words: [null] } },
      type: "speech_to_text_transcription",
    })).rejects.toMatchObject({
      code: "TRANSCRIPTION_INVALID_PAYLOAD",
      details: { provider: "elevenlabs" },
    })
  })

  it.each([
    [401, "TRANSCRIPTION_AUTHENTICATION_FAILED"],
    [422, "TRANSCRIPTION_INVALID_REQUEST"],
    [429, "TRANSCRIPTION_RATE_LIMITED"],
    [503, "TRANSCRIPTION_PROVIDER_FAILED"],
  ] as const)("maps HTTP %s to a stable %s error", async (status, code) => {
    const client = createTranscription({
      driver: elevenLabsScribe({
        apiKey: "secret",
        fetch: vi.fn(async () => Response.json({ detail: "rejected" }, { status })),
        webhookId: "webhook-1",
      }),
    })

    const error = await client.submit({ source: { url: "https://example.com/audio.mp3" } }).then(() => undefined, cause => cause as TranscriptionFailure)
    expect(error?.toJSON()).toEqual({
      code,
      details: { provider: "elevenlabs", status },
      message: error?.message,
      name: "ViteHubError",
    })
  })

  it("rejects malformed callback payloads at the adapter seam", async () => {
    const client = createTranscription({
      driver: elevenLabsScribe({ apiKey: "secret", fetch: vi.fn(), webhookId: "webhook-1" }),
    })

    await expect(client.receive({ data: { request_id: "request-1" }, type: "other" })).rejects.toMatchObject({
      code: "TRANSCRIPTION_INVALID_PAYLOAD",
      details: { provider: "elevenlabs" },
    })
  })

  it("preserves structural cancellation and existing Transcription errors exactly", async () => {
    const abort = { message: "private abort", name: "AbortError" }
    const aborted = createTranscription({
      driver: elevenLabsScribe({
        apiKey: "secret",
        fetch: vi.fn(async () => Promise.reject(abort)),
        webhookId: "webhook-1",
      }),
    })
    await expect(aborted.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toBe(abort)

    const existing = new ViteHubError("TRANSCRIPTION_AUTHENTICATION_FAILED", "Custom authentication failure.", { details: { provider: "elevenlabs" } })
    const preserved = createTranscription({
      driver: elevenLabsScribe({ apiKey: () => Promise.reject(existing), fetch: vi.fn(), webhookId: "webhook-1" }),
    })
    await expect(preserved.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toBe(existing)
  })
})
