import { isTranscriptionAbortError, isTranscriptionError, transcriptionError } from "./transcription.ts"

import type {
  TranscriptionDriver,
  TranscriptionDriverCompletion,
  TranscriptionMetadata,
  TranscriptionSubmitInput,
  TranscriptionTranscript,
  TranscriptionWord,
} from "./transcription.ts"
import type { MaybePromise } from "../types.ts"

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type ElevenLabsModel = "scribe_v1" | "scribe_v2"
type TimestampGranularity = "character" | "none" | "word"

export interface ElevenLabsScribeOptions {
  apiKey: string | (() => MaybePromise<string>)
  diarize?: boolean
  fetch?: Fetch
  model?: ElevenLabsModel
  noVerbatim?: boolean
  tagAudioEvents?: boolean
  timestampsGranularity?: TimestampGranularity
  webhookId: string
}

interface ElevenLabsWord {
  channel_index?: unknown
  end?: unknown
  speaker_id?: unknown
  start?: unknown
  text?: unknown
  type?: unknown
}

interface ElevenLabsTranscript {
  language_code?: unknown
  language_probability?: unknown
  text?: unknown
  words?: unknown
}

interface ElevenLabsWebhookEvent {
  data?: {
    error?: unknown
    request_id?: unknown
    transcription?: unknown
    webhook_metadata?: unknown
  }
  type?: unknown
}

const endpoint = "https://api.elevenlabs.io/v1/speech-to-text"

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function assertOptions(options: ElevenLabsScribeOptions): void {
  if (!options || typeof options !== "object") throw new TypeError("[vitehub] elevenLabsScribe() requires options.")
  if (typeof options.apiKey !== "string" && typeof options.apiKey !== "function") {
    throw new TypeError("[vitehub] elevenLabsScribe({ apiKey }) requires a string or resolver.")
  }
  if (!nonEmptyString(options.webhookId)) {
    throw new TypeError("[vitehub] elevenLabsScribe({ webhookId }) requires a non-empty webhook id.")
  }
}

function mapWord(value: ElevenLabsWord): TranscriptionWord | undefined {
  if (typeof value.text !== "string" || !nonEmptyString(value.type)) return
  return {
    ...(typeof value.channel_index === "number" && Number.isFinite(value.channel_index) ? { channel: value.channel_index } : {}),
    ...(typeof value.end === "number" && Number.isFinite(value.end) ? { end: value.end } : {}),
    ...(nonEmptyString(value.speaker_id) ? { speaker: value.speaker_id } : {}),
    ...(typeof value.start === "number" && Number.isFinite(value.start) ? { start: value.start } : {}),
    text: value.text,
    type: value.type,
  }
}

function mapTranscript(value: unknown): TranscriptionTranscript {
  if (!value || typeof value !== "object") {
    throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", { provider: "elevenlabs" })
  }
  const transcript = value as ElevenLabsTranscript
  if (typeof transcript.text !== "string") {
    throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", { provider: "elevenlabs" })
  }
  const words = Array.isArray(transcript.words)
    ? transcript.words.map(word => mapWord(word as ElevenLabsWord)).filter((word): word is TranscriptionWord => Boolean(word))
    : undefined
  return {
    ...(nonEmptyString(transcript.language_code) ? { language: transcript.language_code } : {}),
    ...(typeof transcript.language_probability === "number" && Number.isFinite(transcript.language_probability)
      ? { languageConfidence: transcript.language_probability }
      : {}),
    text: transcript.text,
    ...(words ? { words } : {}),
  }
}

function mapMetadata(value: unknown): TranscriptionMetadata | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as TranscriptionMetadata
    : undefined
}

function receive(payload: unknown): TranscriptionDriverCompletion {
  try {
    if (!payload || typeof payload !== "object") {
      throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", { provider: "elevenlabs" })
    }
    const event = payload as ElevenLabsWebhookEvent
    if (event.type !== "speech_to_text_transcription" || !nonEmptyString(event.data?.request_id)) {
      throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", { provider: "elevenlabs" })
    }
    const metadata = mapMetadata(event.data.webhook_metadata)
    if (event.data.transcription) {
      return {
        id: event.data.request_id,
        ...(metadata ? { metadata } : {}),
        status: "completed",
        transcript: mapTranscript(event.data.transcription),
      }
    }
    return {
      error: nonEmptyString(event.data.error) ? event.data.error : "ElevenLabs returned no transcription.",
      id: event.data.request_id,
      ...(metadata ? { metadata } : {}),
      status: "failed",
    }
  }
  catch (cause) {
    if (isTranscriptionError(cause)) throw cause
    throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", { cause, provider: "elevenlabs" })
  }
}

function errorCode(status: number): import("./transcription.ts").TranscriptionErrorCode {
  if (status === 401 || status === 403) return "TRANSCRIPTION_AUTHENTICATION_FAILED"
  if (status === 402) return "TRANSCRIPTION_QUOTA_EXCEEDED"
  if (status === 429) return "TRANSCRIPTION_RATE_LIMITED"
  if (status >= 400 && status < 500) return "TRANSCRIPTION_INVALID_REQUEST"
  return "TRANSCRIPTION_PROVIDER_FAILED"
}

async function resolveApiKey(value: ElevenLabsScribeOptions["apiKey"]): Promise<string> {
  const apiKey = typeof value === "function" ? await value() : value
  if (!nonEmptyString(apiKey)) {
    throw transcriptionError("TRANSCRIPTION_AUTHENTICATION_FAILED", { provider: "elevenlabs" })
  }
  return apiKey
}

export function elevenLabsScribe(options: ElevenLabsScribeOptions): TranscriptionDriver {
  assertOptions(options)
  const request = options.fetch || globalThis.fetch
  return {
    name: "elevenlabs",
    receive,
    async submit(input: TranscriptionSubmitInput) {
      const form = new FormData()
      try {
        form.set("model_id", options.model || "scribe_v2")
        form.set("source_url", input.source.url)
        form.set("webhook", "true")
        form.set("webhook_id", options.webhookId)
        if (input.metadata) form.set("webhook_metadata", JSON.stringify(input.metadata))
      }
      catch (cause) {
        throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause, provider: "elevenlabs" })
      }
      if (options.diarize !== undefined) form.set("diarize", String(options.diarize))
      if (options.noVerbatim !== undefined) form.set("no_verbatim", String(options.noVerbatim))
      if (options.tagAudioEvents !== undefined) form.set("tag_audio_events", String(options.tagAudioEvents))
      if (options.timestampsGranularity) form.set("timestamps_granularity", options.timestampsGranularity)

      let response: Response
      try {
        response = await request(endpoint, {
          body: form,
          headers: { "xi-api-key": await resolveApiKey(options.apiKey) },
          method: "POST",
          signal: input.abortSignal,
        })
      }
      catch (cause) {
        if (isTranscriptionAbortError(cause) || isTranscriptionError(cause)) throw cause
        throw transcriptionError("TRANSCRIPTION_NETWORK_FAILED", {
          cause,
          provider: "elevenlabs",
        })
      }
      const body = await response.json().catch(() => undefined) as { detail?: unknown, request_id?: unknown } | undefined
      if (!response.ok) {
        throw transcriptionError(errorCode(response.status), {
          cause: body?.detail ?? response.statusText,
          provider: "elevenlabs",
          status: response.status,
        })
      }
      if (!nonEmptyString(body?.request_id)) {
        throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", { provider: "elevenlabs" })
      }
      return { id: body.request_id }
    },
  }
}
