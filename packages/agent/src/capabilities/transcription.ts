import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

import type { MaybePromise } from "../types.ts"

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
  error: ViteHubError<TranscriptionErrorCode, TranscriptionErrorDetails>
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

export type TranscriptionErrorDetails = {
  provider?: string
  status?: number
}

interface TranscriptionErrorOptions extends ErrorOptions {
  provider?: string
  status?: number
}

export function transcriptionError(code: TranscriptionErrorCode, options?: TranscriptionErrorOptions): ViteHubError<TranscriptionErrorCode, TranscriptionErrorDetails> {
  if (typeof code !== "string" || !Object.hasOwn(transcriptionErrorMessages, code)) {
    throw new TypeError("[vitehub] Transcription errors require a known code.")
  }
  const details = safeErrorDetails(options)
  const cause = readErrorOption(options, "cause")
  return new ViteHubError(code, transcriptionErrorMessages[code], {
    ...(cause === undefined ? {} : { cause }),
    ...(details ? { details } : {}),
  })
}

export function isTranscriptionError(value: unknown): boolean {
  return getViteHubErrorShape(value)?.code.startsWith("TRANSCRIPTION_") === true
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
    throw transcriptionError(code, { cause: new TypeError(`[vitehub] ${field} must be an object.`) })
  }
}

function normalizeSource(source: TranscriptionSource | undefined): TranscriptionSource {
  if (!source || typeof source !== "object") {
    throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source must be an object.") })
  }
  if (typeof source.url !== "string" || !source.url.trim()) {
    throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.url must be a non-empty URL.") })
  }
  let url: URL
  try {
    url = new URL(source.url)
  }
  catch (cause) {
    throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.url must use HTTP or HTTPS.") })
  }
  if (source.mediaType !== undefined && (typeof source.mediaType !== "string" || !source.mediaType.trim())) {
    throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.mediaType must be a non-empty string.") })
  }
  if (source.name !== undefined && (typeof source.name !== "string" || !source.name.trim())) {
    throw transcriptionError("TRANSCRIPTION_INVALID_REQUEST", { cause: new TypeError("[vitehub] Transcription source.name must be a non-empty string.") })
  }
  return { ...source, url: url.href }
}

function assertId(id: unknown, provider: string, phase: string): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", {
      cause: new TypeError(`[vitehub] Transcription driver ${provider} returned an invalid ${phase} id.`),
      provider,
    })
  }
}

function invalidPayload(provider: string, cause?: unknown): ViteHubError<TranscriptionErrorCode, TranscriptionErrorDetails> {
  return transcriptionError("TRANSCRIPTION_INVALID_PAYLOAD", {
    ...(cause === undefined ? {} : { cause }),
    provider,
  })
}

function inspectDriverResult<T>(provider: string, inspect: () => T): T {
  try {
    return inspect()
  }
  catch (cause) {
    if (isTranscriptionError(cause)) throw cause
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

function normalizeTranscript(transcript: TranscriptionTranscript): TranscriptionTranscript {
  return {
    ...(transcript.language === undefined ? {} : { language: transcript.language }),
    ...(transcript.languageConfidence === undefined ? {} : { languageConfidence: transcript.languageConfidence }),
    text: transcript.text,
    ...(transcript.words === undefined
      ? {}
      : {
          words: transcript.words.map(word => ({
            ...(word.channel === undefined ? {} : { channel: word.channel }),
            ...(word.end === undefined ? {} : { end: word.end }),
            ...(word.speaker === undefined ? {} : { speaker: word.speaker }),
            ...(word.start === undefined ? {} : { start: word.start }),
            text: word.text,
            type: word.type,
          })),
        }),
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
        error: transcriptionError("TRANSCRIPTION_PROVIDER_FAILED", {
          cause: new Error(completion.error),
          provider,
        }),
        id: completion.id,
        ...(completion.metadata ? { metadata: completion.metadata } : {}),
        provider,
        status: "failed",
      }
    }
    if (completion.status === "completed") {
      assertTranscript(completion.transcript, provider)
      return {
        id: completion.id,
        ...(completion.metadata ? { metadata: completion.metadata } : {}),
        provider,
        status: "completed",
        transcript: normalizeTranscript(completion.transcript),
      }
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

function readErrorOption(options: unknown, key: "cause" | "provider" | "status"): unknown {
  if ((typeof options !== "object" || options === null) && typeof options !== "function") return undefined
  try {
    return Reflect.get(options, key)
  }
  catch {
    return undefined
  }
}

function safeErrorDetails(options: unknown): TranscriptionErrorDetails | undefined {
  const provider = safeProvider(readErrorOption(options, "provider"))
  const rawStatus = readErrorOption(options, "status")
  const status = typeof rawStatus === "number"
    && Number.isInteger(rawStatus)
    && rawStatus >= 100
    && rawStatus <= 599
    ? rawStatus
    : undefined
  return provider || status ? { ...(provider ? { provider } : {}), ...(status ? { status } : {}) } : undefined
}

function safeProvider(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : undefined
}
