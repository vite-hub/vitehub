import type { MaybePromise } from "../types.ts"

export type TranscriptionErrorCode = "authentication" | "invalid-payload" | "invalid-request" | "network" | "provider" | "rate-limit"
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

export type TranscriptionCompletion =
  | (Extract<TranscriptionDriverCompletion, { status: "failed" }> & { provider: string })
  | (Extract<TranscriptionDriverCompletion, { status: "completed" }> & { provider: string })

export interface TranscriptionClient {
  receive: (payload: unknown) => Promise<TranscriptionCompletion>
  submit: (input: TranscriptionSubmitInput) => Promise<TranscriptionSubmission>
}

export interface CreateTranscriptionOptions {
  driver: TranscriptionDriver
}

export interface TranscriptionErrorOptions {
  cause?: unknown
  provider?: string
}

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode
  readonly provider?: string

  constructor(code: TranscriptionErrorCode, message: string, options: TranscriptionErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = "TranscriptionError"
    this.code = code
    this.provider = options.provider
  }
}

function assertDriver(driver: unknown): asserts driver is TranscriptionDriver {
  if (!driver || typeof driver !== "object") throw new TypeError("[vitehub] Transcription driver must be an object.")
  const value = driver as Partial<TranscriptionDriver>
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new TypeError("[vitehub] Transcription driver name must be a non-empty string.")
  }
  if (typeof value.submit !== "function") throw new TypeError("[vitehub] Transcription driver submit must be a function.")
  if (typeof value.receive !== "function") throw new TypeError("[vitehub] Transcription driver receive must be a function.")
}

function assertMetadata(metadata: unknown, field: string): asserts metadata is TranscriptionMetadata | undefined {
  if (metadata === undefined) return
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TranscriptionError("invalid-payload", `[vitehub] ${field} must be an object.`)
  }
}

function normalizeSource(source: TranscriptionSource | undefined): TranscriptionSource {
  if (!source || typeof source !== "object") {
    throw new TranscriptionError("invalid-request", "[vitehub] Transcription source must be an object.")
  }
  if (typeof source.url !== "string" || !source.url.trim()) {
    throw new TranscriptionError("invalid-request", "[vitehub] Transcription source.url must be a non-empty URL.")
  }
  let url: URL
  try {
    url = new URL(source.url)
  }
  catch (cause) {
    throw new TranscriptionError("invalid-request", "[vitehub] Transcription source.url must be an absolute URL.", { cause })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TranscriptionError("invalid-request", "[vitehub] Transcription source.url must use HTTP or HTTPS.")
  }
  if (source.mediaType !== undefined && (typeof source.mediaType !== "string" || !source.mediaType.trim())) {
    throw new TranscriptionError("invalid-request", "[vitehub] Transcription source.mediaType must be a non-empty string.")
  }
  if (source.name !== undefined && (typeof source.name !== "string" || !source.name.trim())) {
    throw new TranscriptionError("invalid-request", "[vitehub] Transcription source.name must be a non-empty string.")
  }
  return { ...source, url: url.href }
}

function assertId(id: unknown, provider: string, phase: string): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw new TranscriptionError("provider", `[vitehub] Transcription driver ${provider} returned an invalid ${phase} id.`, { provider })
  }
}

function assertTranscript(transcript: unknown, provider: string): asserts transcript is TranscriptionTranscript {
  if (!transcript || typeof transcript !== "object" || typeof (transcript as { text?: unknown }).text !== "string") {
    throw new TranscriptionError("invalid-payload", `[vitehub] Transcription driver ${provider} returned an invalid transcript.`, { provider })
  }
  const words = (transcript as TranscriptionTranscript).words
  if (words !== undefined && (!Array.isArray(words) || words.some(word => !word || typeof word !== "object" || typeof word.text !== "string" || typeof word.type !== "string"))) {
    throw new TranscriptionError("invalid-payload", `[vitehub] Transcription driver ${provider} returned invalid transcript words.`, { provider })
  }
}

function normalizeCompletion(completion: TranscriptionDriverCompletion, provider: string): TranscriptionCompletion {
  if (!completion || typeof completion !== "object") {
    throw new TranscriptionError("invalid-payload", `[vitehub] Transcription driver ${provider} returned an invalid completion.`, { provider })
  }
  assertId(completion.id, provider, "completion")
  assertMetadata(completion.metadata, "Transcription completion metadata")
  if (completion.status === "failed") {
    if (typeof completion.error !== "string" || !completion.error.trim()) {
      throw new TranscriptionError("invalid-payload", `[vitehub] Transcription driver ${provider} returned an invalid failure.`, { provider })
    }
    return { ...completion, provider }
  }
  if (completion.status === "completed") {
    assertTranscript(completion.transcript, provider)
    return { ...completion, provider }
  }
  throw new TranscriptionError("invalid-payload", `[vitehub] Transcription driver ${provider} returned an unsupported completion status.`, { provider })
}

export function createTranscription(options: CreateTranscriptionOptions): TranscriptionClient {
  assertDriver(options?.driver)
  const driver = options.driver
  return {
    async submit(input): Promise<TranscriptionSubmission> {
      assertMetadata(input?.metadata, "Transcription metadata")
      const normalized = { ...input, source: normalizeSource(input?.source) }
      try {
        const submission = await driver.submit(normalized)
        assertId(submission?.id, driver.name, "submission")
        return { id: submission.id, provider: driver.name, status: "submitted" }
      }
      catch (error) {
        if (error instanceof TranscriptionError) throw error
        throw new TranscriptionError("provider", `[vitehub] Transcription submission failed through ${driver.name}.`, {
          cause: error,
          provider: driver.name,
        })
      }
    },
    async receive(payload): Promise<TranscriptionCompletion> {
      try {
        return normalizeCompletion(await driver.receive(payload), driver.name)
      }
      catch (error) {
        if (error instanceof TranscriptionError) throw error
        throw new TranscriptionError("invalid-payload", `[vitehub] Transcription completion from ${driver.name} was invalid.`, {
          cause: error,
          provider: driver.name,
        })
      }
    },
  }
}
