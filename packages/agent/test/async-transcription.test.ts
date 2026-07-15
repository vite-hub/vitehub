import { describe, expect, it, vi } from "vitest"

import {
  createTranscription,
  elevenLabsScribe,
} from "../src/capabilities.ts"

import type {
  TranscriptionDriver,
  TranscriptionSubmitInput,
} from "../src/capabilities.ts"

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
    [{ source: undefined }, "source must be an object"],
    [{ source: { url: "audio.mp3" } }, "absolute URL"],
    [{ source: { url: "file:///audio.mp3" } }, "HTTP or HTTPS"],
    [{ metadata: [], source: { url: "https://example.com/audio.mp3" } }, "metadata must be an object"],
  ])("rejects an invalid submission before calling the driver", async (input, message) => {
    const driver = fixtureDriver()
    const client = createTranscription({ driver })

    await expect(client.submit(input as TranscriptionSubmitInput)).rejects.toThrow(message)
    expect(driver.submit).not.toHaveBeenCalled()
  })

  it("normalizes unknown driver failures without exposing provider details", async () => {
    const cause = new Error("secret provider response")
    const client = createTranscription({ driver: fixtureDriver({ submit: vi.fn(async () => { throw cause }) }) })

    await expect(client.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toMatchObject({
      cause,
      code: "provider",
      message: "[vitehub] Transcription submission failed through fixture.",
      provider: "fixture",
    })
  })

  it("rejects invalid driver results", async () => {
    const invalidSubmission = createTranscription({ driver: fixtureDriver({ submit: vi.fn(async () => ({ id: "" })) }) })
    const invalidCompletion = createTranscription({ driver: fixtureDriver({ receive: vi.fn(async () => ({ id: "operation-1", status: "queued" } as never)) }) })

    await expect(invalidSubmission.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toThrow("invalid submission id")
    await expect(invalidCompletion.receive({})).rejects.toThrow("unsupported completion status")
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

    await expect(client.receive({
      data: { error: "Unsupported audio", request_id: "request-2", webhook_metadata: { job_id: "job-1" } },
      type: "speech_to_text_transcription",
    })).resolves.toEqual({
      error: "Unsupported audio",
      id: "request-2",
      metadata: { job_id: "job-1" },
      provider: "elevenlabs",
      status: "failed",
    })
  })

  it.each([
    [401, "authentication"],
    [422, "invalid-request"],
    [429, "rate-limit"],
    [503, "provider"],
  ])("maps HTTP %s to a stable %s error", async (status, code) => {
    const client = createTranscription({
      driver: elevenLabsScribe({
        apiKey: "secret",
        fetch: vi.fn(async () => Response.json({ detail: "rejected" }, { status })),
        webhookId: "webhook-1",
      }),
    })

    await expect(client.submit({ source: { url: "https://example.com/audio.mp3" } })).rejects.toMatchObject({
      code: code as never,
      provider: "elevenlabs",
    })
  })

  it("rejects malformed callback payloads at the adapter seam", async () => {
    const client = createTranscription({
      driver: elevenLabsScribe({ apiKey: "secret", fetch: vi.fn(), webhookId: "webhook-1" }),
    })

    await expect(client.receive({ data: { request_id: "request-1" }, type: "other" })).rejects.toMatchObject({
      code: "invalid-payload",
      provider: "elevenlabs",
    })
  })
})
