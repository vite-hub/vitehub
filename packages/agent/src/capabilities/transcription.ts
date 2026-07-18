import { ViteHubError } from "@vite-hub/runtime"

import type { MaybePromise } from "../types.ts"
import type { ViteHubErrorDetails, ViteHubErrorShape } from "@vite-hub/runtime"

const transcriptionErrorMessages = {
  TRANSCRIPTION_AUTHENTICATION_FAILED: "[vitehub] Transcription authentication failed.",
  TRANSCRIPTION_INVALID_PAYLOAD: "[vitehub] Transcription provider returned an invalid payload.",
  TRANSCRIPTION_INVALID_REQUEST: "[vitehub] Transcription request is invalid.",
  TRANSCRIPTION_NETWORK_FAILED: "[vitehub] Transcription provider request failed.",
  TRANSCRIPTION_PROVIDER_FAILED: "[vitehub] Transcription provider failed.",
  TRANSCRIPTION_RATE_LIMITED: "[vitehub] Transcription provider rate limit exceeded.",
} as const

export type TranscriptionErrorCode = keyof typeof transcriptionErrorMessages
export type TranscriptionMetadata = Readonly<Record<string, unknown>>

export interface TranscriptionSource {
  mediaType?: string
  name?: string
  url: string
}

export interface TranscriptionWord {
  channel?: number
  end?: number
  speaker?: string
  start?: number
  text: string
  type: string
}

export interface TranscriptionTranscript {
  language?: string
  languageConfidence?: number
  text: string
  words?: readonly TranscriptionWord[]
}

export interface TranscriptionSubmitInput {
  abortSignal?: AbortSignal
  metadata?: TranscriptionMetadata
  source: TranscriptionSource
}

export interface TranscriptionDriverSubmission {
  id: string
}

export type TranscriptionDriverCompletion =
  | {
    error: string
    id: string
    metadata?: TranscriptionMetadata
    status: "failed"
  }
  | {
    id: string
    metadata?: TranscriptionMetadata
    status: "completed"
    transcript: TranscriptionTranscript
  }

export interface TranscriptionDriver {
  name: string
  receive: (payload: unknown) => MaybePromise<TranscriptionDriverCompletion>
  submit: (input: TranscriptionSubmitInput) => MaybePromise<TranscriptionDriverSubmission>
}

export interface TranscriptionSubmission extends TranscriptionDriverSubmission {
  provider: string
  status: "submitted"
}

export interface TranscriptionFailedCompletion {
  error: TranscriptionError
  id: string
  metadata?: TranscriptionMetadata
  provider: string
  status: "failed"
}

export type TranscriptionCompletion =
  | TranscriptionFailedCompletion
  | (Extract<TranscriptionDriverCompletion, { status: "completed" }> & { provider: string })

export interface TranscriptionClient {
  receive: (payload: unknown) => Promise<TranscriptionCompletion>
  submit: (input: TranscriptionSubmitInput) => Promise<TranscriptionSubmission>
}

export interface CreateTranscriptionOptions {
  driver: TranscriptionDriver
}

export interface TranscriptionErrorDetails extends ViteHubErrorDetails {
  provider?: string
  status?: number
}

export type TranscriptionErrorJSON = ViteHubErrorShape<TranscriptionErrorCode, TranscriptionErrorDetails>

export interface TranscriptionErrorOptions extends ErrorOptions {
  provider?: string
  status?: number
}

export class TranscriptionError extends ViteHubError<TranscriptionErrorCode, TranscriptionErrorDetails> {
  constructor(code: TranscriptionErrorCode, options: TranscriptionErrorOptions = {}) {
    if (!Object.hasOwn(transcriptionErrorMessages, code)) {
      throw new TypeError("[vitehub] TranscriptionError requires a known transcription error code.")
    }
    const details = safeErrorDetails(options)
    super(code, transcriptionErrorMessages[code], {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(details ? { details } : {}),
      retryable: code === "TRANSCRIPTION_NETWORK_FAILED"
        || code === "TRANSCRIPTION_PROVIDER_FAILED"
        || code === "TRANSCRIPTION_RATE_LIMITED",
    })
    this.name = "TranscriptionError"
  }
}

function assertDriver(driver: unknown): asserts driver is TranscriptionDriver {
  if (!driver || typeof driver !== "object") throw new TypeError("[vitehub] Transcription driver must be an object.")
  const value = driver as Partial<TranscriptionDriver>
  if (!safeProvider(value.name)) {
    throw new TypeError("[vitehub] Transcription driver name must be a safe identifier.")
  }
  if (typeof value.submit !== "function") throw new TypeError("[vitehub] Transcription driver submit must be a function.")
  if (typeof value.receive !== "function") throw new TypeError("[vitehub] Transcription driver receive must be a function.")
}

function assertMetadata(
  metadata: unknown,
  field: string,
  code: "TRANSCRIPTION_INVALID_PAYLOAD" | "TRANSCRIPTION_INVALID_REQUEST",
): asserts metadata is TranscriptionMetadata | undefined {
  if (metadata === undefined) return
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TranscriptionError(code, { cause: new TypeError(`[vitehub] ${field} must be an object.`) })
  }
}

function normalizeSource(source: TranscriptionSource | undefined): TranscriptionSource {
  if (!source || typeof source !== "object") {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source must be an object.") })
  }
  if (typeof source.url !== "string" || !source.url.trim()) {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.url must be a non-empty URL.") })
  }
  let url: URL
  try {
    url = new URL(source.url)
  }
  catch (cause) {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.url must use HTTP or HTTPS.") })
  }
  if (source.mediaType !== undefined && (typeof source.mediaType !== "string" || !source.mediaType.trim())) {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.mediaType must be a non-empty string.") })
  }
  if (source.name !== undefined && (typeof source.name !== "string" || !source.name.trim())) {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.name must be a non-empty string.") })
  }
  return { ...source, url: url.href }
}

function assertId(id: unknown, provider: string, phase: string): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_PAYLOAD", {
      cause: new TypeError(`[vitehub] Transcription driver ${provider} returned an invalid ${phase} id.`),
      provider,
    })
  }
}

function invalidPayload(provider: string, cause?: unknown): TranscriptionError {
  return new TranscriptionError("TRANSCRIPTION_INVALID_PAYLOAD", {
    ...(cause === undefined ? {} : { cause }),
    provider,
  })
}

function inspectDriverResult<T>(provider: string, inspect: () => T): T {
  try {
    return inspect()
  }
  catch (cause) {
    if (cause instanceof TranscriptionError) throw cause
    throw invalidPayload(provider, cause)
  }
}

function assertTranscript(transcript: unknown, provider: string): asserts transcript is TranscriptionTranscript {
  if (!transcript || typeof transcript !== "object" || typeof (transcript as { text?: unknown }).text !== "string") {
    throw invalidPayload(provider)
  }
  const words = (transcript as TranscriptionTranscript).words
  if (words !== undefined && (!Array.isArray(words) || words.some(word => !word || typeof word !== "object" || typeof word.text !== "string" || typeof word.type !== "string"))) {
    throw invalidPayload(provider)
  }
}

function normalizeCompletion(completion: TranscriptionDriverCompletion, provider: string): TranscriptionCompletion {
  return inspectDriverResult(provider, () => {
    if (!completion || typeof completion !== "object") throw invalidPayload(provider)
    assertId(completion.id, provider, "completion")
    assertMetadata(completion.metadata, "Transcription completion metadata", "TRANSCRIPTION_INVALID_PAYLOAD")
    if (completion.status === "failed") {
      if (typeof completion.error !== "string" || !completion.error.trim()) throw invalidPayload(provider)
      return {
        ...completion,
        error: new TranscriptionError("TRANSCRIPTION_PROVIDER_FAILED", {
          cause: new Error(completion.error),
          provider,
        }),
        provider,
      }
    }
    if (completion.status === "completed") {
      assertTranscript(completion.transcript, provider)
      return { ...completion, provider }
    }
    throw invalidPayload(provider)
  })
}

export function createTranscription(options: CreateTranscriptionOptions): TranscriptionClient {
  assertDriver(options?.driver)
  const driver = options.driver
  return {
    async submit(input): Promise<TranscriptionSubmission> {
      assertMetadata(input?.metadata, "Transcription metadata", "TRANSCRIPTION_INVALID_REQUEST")
      const normalized = { ...input, source: normalizeSource(input?.source) }
      const submission = await driver.submit(normalized)
      const id = inspectDriverResult(driver.name, () => {
        if (!submission || typeof submission !== "object") throw invalidPayload(driver.name)
        assertId(submission.id, driver.name, "submission")
        return submission.id
      })
      return { id, provider: driver.name, status: "submitted" }
    },
    async receive(payload): Promise<TranscriptionCompletion> {
      return normalizeCompletion(await driver.receive(payload), driver.name)
    },
  }
}

export function isTranscriptionAbortError(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false
  try {
    return (value as { name?: unknown }).name === "AbortError"
  }
  catch {
    return false
  }
}

function safeErrorDetails(options: TranscriptionErrorOptions): TranscriptionErrorDetails | undefined {
  const provider = safeProvider(options.provider)
  const status = typeof options.status === "number"
    && Number.isInteger(options.status)
    && options.status >= 100
    && options.status <= 599
    ? options.status
    : undefined
  return provider || status ? { ...(provider ? { provider } : {}), ...(status ? { status } : {}) } : undefined
}

function safeProvider(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : undefined
}
