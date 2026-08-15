import { defineCapability } from "../capability-runtime.ts"
import { appendMessageText } from "../messages.ts"
import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"
import { isTranscriptionAbortError, isTranscriptionError, transcriptionError } from "./transcription.ts"

import type {
  AgentCapabilityRuntimeContext,
  AgentCapabilityDefinition,
  AgentInvocationContextStore,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { AudioData, AudioPart, Message } from "../messages.ts"
import type { WritableWorkspaceFacade, WorkspaceContent, WorkspaceName } from "@vite-hub/workspace"

type AiSdkTranscribe = typeof import("ai")["transcribe"]
type AiSdkTranscribeOptions = Omit<Parameters<AiSdkTranscribe>[0], "abortSignal" | "audio">
type AiSdkTranscriptionResult = Awaited<ReturnType<AiSdkTranscribe>>
type AiSdkStreamTranscribe = typeof import("ai")["experimental_streamTranscribe"]
type AiSdkStreamTranscriptionResult = ReturnType<AiSdkStreamTranscribe>
type TranscribeArtifactValue<T, TInput> = T | ((input: TInput) => MaybePromise<T>)
const DEFAULT_TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024
const resolvedAudioData = new WeakMap<AudioPart, Promise<AudioData>>()

export interface TranscribeExecuteInput {
  audio: AudioPart
}

export type TranscribeExecuteResult = AiSdkTranscriptionResult | string

export type StreamTranscriptionOptions = Omit<Parameters<AiSdkStreamTranscribe>[0], "_internal">

export interface StreamingTranscription {
  result: AiSdkStreamTranscriptionResult
  text: AiSdkStreamTranscriptionResult["text"]
  textStream: AsyncIterable<string>
}

export interface TranscriptionResult {
  audioPath?: string
  createdAt: string
  date: string
  messageId: string
  stem: string
  transcript: string
  transcriptPath?: string
}

export interface TranscribeArtifactTemplateInput extends TranscriptionResult {
  audio: AudioPart
  audioCount: number
  audioExtension: string
  audioIndex: number
  message: Message
}

export interface TranscribeAudioArtifactOptions {
  mediaType?: TranscribeArtifactValue<string | undefined, TranscribeArtifactTemplateInput>
  path?: TranscribeArtifactValue<string, TranscribeArtifactTemplateInput>
}

export interface TranscribeTranscriptArtifactOptions {
  format?: "markdown" | "text"
  mediaType?: TranscribeArtifactValue<string | undefined, TranscribeArtifactTemplateInput>
  path?: TranscribeArtifactValue<string, TranscribeArtifactTemplateInput>
  template?: (input: TranscribeArtifactTemplateInput) => MaybePromise<WorkspaceContent>
}

export interface TranscribeArtifactsOptions {
  audio?: boolean | TranscribeAudioArtifactOptions
  directory?: TranscribeArtifactValue<string, TranscribeArtifactTemplateInput>
  transcript?: false | TranscribeTranscriptArtifactOptions
}

export const TRANSCRIPTION_RESULTS_CONTEXT_KEY = "transcribe.results"

type StaticTranscribeOptions =
  | (AiSdkTranscribeOptions & {
    artifacts?: TranscribeArtifactsOptions
    execute?: never
    maxBytes?: number
  })
  | {
    artifacts?: TranscribeArtifactsOptions
    execute: (input: TranscribeExecuteInput) => MaybePromise<TranscribeExecuteResult>
    maxBytes?: number
    model?: never
  }

export type TranscribeOptions = StaticTranscribeOptions | (() => MaybePromise<StaticTranscribeOptions>)

async function* transcriptionTextStream(
  stream: AiSdkStreamTranscriptionResult["fullStream"],
  text: AiSdkStreamTranscriptionResult["text"],
): AsyncIterable<string> {
  let streamedText = ""
  for await (const part of stream) {
    if (part.type === "error") throw part.error
    if (part.type === "transcript-delta" && part.delta) {
      streamedText += part.delta
      yield part.delta
    }
  }
  const finalText = await text
  const suffix = finalText.startsWith(streamedText) ? finalText.slice(streamedText.length) : ""
  if (suffix) yield suffix
  else if (!streamedText && finalText) yield finalText
}

export async function streamTranscription(options: StreamTranscriptionOptions): Promise<StreamingTranscription> {
  const aiSdk = await loadAiSdk() as typeof import("ai") & {
    experimental_streamTranscribe?: AiSdkStreamTranscribe
  }
  if (!aiSdk.experimental_streamTranscribe) {
    throw new TypeError("[vitehub] streamTranscription() requires ai.experimental_streamTranscribe.")
  }
  const result = aiSdk.experimental_streamTranscribe(options)
  void result.text.then(undefined, () => {})
  return {
    result,
    text: result.text,
    textStream: transcriptionTextStream(result.fullStream, result.text),
  }
}

function isAudioPart(part: unknown): part is AudioPart {
  return !!part
    && typeof part === "object"
    && (part as { type?: unknown }).type === "audio"
    && typeof (part as { mediaType?: unknown }).mediaType === "string"
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return DEFAULT_TRANSCRIBE_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("[vitehub] transcribe({ maxBytes }) must be a positive finite number.")
  }
  return maxBytes
}

function assertWithinMaxBytes(byteLength: number | undefined, maxBytes: number, source: string): void {
  if (typeof byteLength === "number" && byteLength > maxBytes) {
    throw new Error(`[vitehub] transcribe() ${source} is ${byteLength} bytes, which exceeds maxBytes (${maxBytes}).`)
  }
}

async function resolveAudioData(audio: AudioPart, maxBytes: number): Promise<AudioData | undefined> {
  assertWithinMaxBytes(audio.size, maxBytes, "audio")
  if (audio.data instanceof Blob) assertWithinMaxBytes(audio.data.size, maxBytes, "audio data")
  else if (audio.data instanceof ArrayBuffer) assertWithinMaxBytes(audio.data.byteLength, maxBytes, "audio data")
  else if (ArrayBuffer.isView(audio.data)) assertWithinMaxBytes(audio.data.byteLength, maxBytes, "audio data")
  if (audio.data) return audio.data
  if (!audio.fetchData) return

  let cached = resolvedAudioData.get(audio)
  if (!cached) {
    cached = Promise.resolve(audio.fetchData()).catch((error) => {
      resolvedAudioData.delete(audio)
      throw error
    })
    resolvedAudioData.set(audio, cached)
  }
  const data = await cached
  if (data instanceof Blob) assertWithinMaxBytes(data.size, maxBytes, "downloaded audio")
  else if (data instanceof ArrayBuffer) assertWithinMaxBytes(data.byteLength, maxBytes, "downloaded audio")
  else if (ArrayBuffer.isView(data)) assertWithinMaxBytes(data.byteLength, maxBytes, "downloaded audio")
  else if (typeof data === "string") assertWithinMaxBytes(data.length, maxBytes, "downloaded audio")
  return data
}

async function toAiSdkAudio(audio: AudioPart, maxBytes: number): Promise<Parameters<AiSdkTranscribe>[0]["audio"]> {
  const data = await resolveAudioData(audio, maxBytes)
  if (data instanceof Blob) return await data.arrayBuffer()
  if (data) return data
  if (audio.url) return new URL(audio.url)
  throw new TypeError("[vitehub] transcribe() requires audio data, fetchData, or url.")
}

function normalizeAudioMediaType(mediaType = ""): string {
  return mediaType.toLowerCase().split(";")[0]?.trim() || ""
}

export function audioExtensionFor(mediaType = ""): string {
  const normalized = normalizeAudioMediaType(mediaType)
  if (normalized === "audio/aac") return "aac"
  if (normalized === "audio/flac" || normalized === "audio/x-flac") return "flac"
  if (normalized === "audio/mpeg") return "mp3"
  if (normalized === "audio/mp4" || normalized === "audio/x-m4a") return "m4a"
  if (normalized === "audio/ogg" || normalized === "audio/opus") return "ogg"
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return "wav"
  if (normalized === "audio/webm") return "webm"
  return "ogg"
}

function bytesFromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

function bytesFromAudioString(value: string): Uint8Array {
  const dataUrl = /^data:([^,]*),(.*)$/i.exec(value)
  if (dataUrl?.[1]?.toLowerCase().split(";").includes("base64")) return bytesFromBase64(dataUrl[2] || "")
  if (dataUrl?.[2]) return new TextEncoder().encode(decodeURIComponent(dataUrl[2]))
  return new TextEncoder().encode(value)
}

async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength)) {
    try {
      assertWithinMaxBytes(contentLength, maxBytes, "downloaded audio")
    }
    catch (error) {
      await response.body?.cancel(error).catch(() => undefined)
      throw error
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    assertWithinMaxBytes(bytes.byteLength, maxBytes, "downloaded audio")
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      byteLength += chunk.byteLength
      assertWithinMaxBytes(byteLength, maxBytes, "downloaded audio")
      chunks.push(chunk)
    }
  }
  catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function audioBytes(audio: AudioPart, options?: { maxBytes?: number }): Promise<Uint8Array> {
  const maxBytes = normalizeMaxBytes(options?.maxBytes)
  const data = await resolveAudioData(audio, maxBytes)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === "string") {
    const bytes = bytesFromAudioString(data)
    assertWithinMaxBytes(bytes.byteLength, maxBytes, "audio data")
    return bytes
  }
  if (audio.url) {
    const response = await fetch(audio.url)
    if (!response.ok) throw new Error(`[vitehub] Failed to download audio: ${response.status} ${response.statusText}.`)
    return await responseBytes(response, maxBytes)
  }
  throw new TypeError("[vitehub] transcribe() requires audio data, fetchData, or url.")
}

function transcriptText(result: TranscribeExecuteResult): string {
  return typeof result === "string" ? result : result.text
}

async function resolveTranscribeOptions(options: TranscribeOptions): Promise<StaticTranscribeOptions> {
  return typeof options === "function" ? await options() : options
}

function normalizeAiSdkTranscriptionError(aiSdk: typeof import("ai"), cause: unknown): unknown {
  if (isTranscriptionAbortError(cause) || isTranscriptionError(cause)) return cause
  const providerError = aiSdk.RetryError.isInstance(cause) ? cause.lastError : cause
  if (isTranscriptionAbortError(providerError)) return providerError
  if (aiSdk.LoadAPIKeyError?.isInstance(providerError)) {
    return transcriptionError("TRANSCRIPTION_AUTHENTICATION_FAILED", { cause })
  }
  if (!aiSdk.APICallError.isInstance(providerError)) {
    return transcriptionError("TRANSCRIPTION_PROVIDER_FAILED", { cause })
  }
  const status = providerError.statusCode
  const code = status === 401 || status === 403
    ? "TRANSCRIPTION_AUTHENTICATION_FAILED"
    : status === 402
      ? "TRANSCRIPTION_QUOTA_EXCEEDED"
      : status === 429
        ? "TRANSCRIPTION_RATE_LIMITED"
        : status !== undefined && status >= 400 && status < 500
          ? "TRANSCRIPTION_INVALID_REQUEST"
          : status === undefined
            ? "TRANSCRIPTION_NETWORK_FAILED"
            : "TRANSCRIPTION_PROVIDER_FAILED"
  return transcriptionError(code, { cause, status })
}

async function runTranscription(options: StaticTranscribeOptions, audio: AudioPart, abortSignal?: AbortSignal): Promise<string> {
  if ("execute" in options && options.execute) {
    return transcriptText(await options.execute({ audio }))
  }

  const {
    artifacts: _artifacts,
    maxBytes: maxBytesOption,
    ...transcribeOptions
  } = options
  const maxBytes = normalizeMaxBytes(maxBytesOption)
  const aiSdk = await loadAiSdk() as typeof import("ai") & {
    experimental_transcribe?: AiSdkTranscribe
    transcribe?: AiSdkTranscribe
  }
  const transcribe = Object.hasOwn(aiSdk, "transcribe") ? aiSdk.transcribe : aiSdk.experimental_transcribe
  if (!transcribe) throw new TypeError("[vitehub] transcribe() requires ai.transcribe or ai.experimental_transcribe.")
  const aiAudio = await toAiSdkAudio(audio, maxBytes)
  try {
    const result = await transcribe({
      ...transcribeOptions,
      abortSignal,
      audio: aiAudio,
      download: transcribeOptions.download ?? aiSdk.createDownload({ maxBytes }),
    })
    return result.text
  }
  catch (cause) {
    throw normalizeAiSdkTranscriptionError(aiSdk, cause)
  }
}

function isWritableWorkspace(workspace: unknown): workspace is WritableWorkspaceFacade {
  return !!workspace && typeof workspace === "object" && "fs" in workspace && "snapshot" in workspace
}

function joinWorkspacePath(...parts: Array<string | undefined>): string {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/")
}

function normalizeTranscribeArtifactPath(path: string, option: string): string {
  const raw = path.replaceAll("\\", "/")
  const normalized = raw.replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)

  if (!parts.length || raw.startsWith("/") || parts.some(part => part === "." || part === "..") || parts[0] === ".git" || parts[0] === ".vitehub")
    throw new TypeError(`[vitehub] transcribe({ ${option} }) must be a safe workspace path.`)

  return parts.join("/")
}

function defaultCreatedAt(message: Message): Date {
  const value = message.createdAt ? new Date(message.createdAt) : new Date()
  return Number.isNaN(value.getTime()) ? new Date() : value
}

function safeArtifactStemPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "")
    || "item"
}

function defaultStem(input: Pick<TranscribeArtifactTemplateInput, "audioCount" | "audioIndex" | "createdAt" | "messageId">): string {
  const suffix = input.audioCount > 1 ? `-${input.audioIndex + 1}` : ""
  const createdAt = safeArtifactStemPart(input.createdAt.replace(/\.\d{3}Z$/, "Z"))
  const messageId = safeArtifactStemPart(input.messageId)
  return `${createdAt}-${messageId}${suffix}`
}

function pathExtension(path: string): string | undefined {
  const filename = path.split("/").at(-1) || ""
  const dotIndex = filename.lastIndexOf(".")
  return dotIndex > 0 && dotIndex < filename.length - 1 ? filename.slice(dotIndex + 1) : undefined
}

function pathDirectory(path: string): string {
  const segments = path.split("/")
  segments.pop()
  return segments.join("/")
}

function pathStem(path: string): string | undefined {
  const filename = path.split("/").at(-1) || ""
  if (!filename) return
  const dotIndex = filename.lastIndexOf(".")
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename
}

async function resolveArtifactValue<T>(
  value: TranscribeArtifactValue<T, TranscribeArtifactTemplateInput>,
  input: TranscribeArtifactTemplateInput,
): Promise<T> {
  return typeof value === "function"
    ? await (value as (input: TranscribeArtifactTemplateInput) => MaybePromise<T>)(input)
    : value
}

function getAudioArtifactOptions(artifacts: TranscribeArtifactsOptions): TranscribeAudioArtifactOptions | undefined {
  if (artifacts.audio === false) return
  if (artifacts.audio && typeof artifacts.audio === "object") return artifacts.audio
  return {}
}

function getTranscriptArtifactOptions(artifacts: TranscribeArtifactsOptions): TranscribeTranscriptArtifactOptions | undefined {
  if (artifacts.transcript === false) return
  if (artifacts.transcript && typeof artifacts.transcript === "object") return artifacts.transcript
  return {}
}

function createBaseTranscriptionResult(
  context: AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>,
  message: Message,
  audio: AudioPart,
  transcript: string,
  audioIndex: number,
  audioCount: number,
): TranscribeArtifactTemplateInput {
  const createdAtDate = defaultCreatedAt(message)
  const createdAt = createdAtDate.toISOString()
  const messageId = context.run?.messageId || message.id
  const base = {
    audio,
    audioCount,
    audioExtension: audioExtensionFor(audio.mediaType),
    audioIndex,
    audioPath: undefined,
    createdAt,
    date: createdAt.slice(0, 10),
    message,
    messageId,
    stem: "",
    transcript,
    transcriptPath: undefined,
  } satisfies TranscribeArtifactTemplateInput
  return {
    ...base,
    stem: defaultStem(base),
  }
}

async function writeTranscriptionArtifacts(
  context: AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>,
  artifacts: TranscribeArtifactsOptions | undefined,
  message: Message,
  audio: AudioPart,
  transcript: string,
  audioIndex: number,
  audioCount: number,
  maxBytes: number,
): Promise<TranscriptionResult> {
  let input = createBaseTranscriptionResult(context, message, audio, transcript, audioIndex, audioCount)
  if (!artifacts) {
    return toTranscriptionResult(input)
  }
  if (!isWritableWorkspace(context.workspace)) {
    throw new Error("[vitehub] transcribe({ artifacts }) requires workspace.mode: \"write\".")
  }

  const audioOptions = getAudioArtifactOptions(artifacts)
  const transcriptOptions = getTranscriptArtifactOptions(artifacts)
  const artifactDirectory = artifacts.directory
    ? normalizeTranscribeArtifactPath(await resolveArtifactValue(artifacts.directory, input), "artifacts.directory")
    : undefined
  const defaultTranscriptExtension = transcriptOptions?.format === "markdown" ? "md" : "txt"
  const defaultTranscriptPath = joinWorkspacePath(
    artifactDirectory || "transcripts",
    artifactDirectory ? undefined : input.date,
    `${input.stem}.${defaultTranscriptExtension}`,
  )
  const transcriptPath = transcriptOptions
    ? normalizeTranscribeArtifactPath(
        transcriptOptions.path ? await resolveArtifactValue(transcriptOptions.path, input) : defaultTranscriptPath,
        "artifacts.transcript.path",
      )
    : undefined

  if (transcriptPath)
    input = { ...input, transcriptPath }
  const resolvedArtifactDirectory = transcriptPath ? pathDirectory(transcriptPath) : artifactDirectory || joinWorkspacePath("audio", input.date)
  const artifactStem = transcriptPath ? pathStem(transcriptPath) || input.stem : input.stem

  if (audioOptions) {
    const defaultAudioPath = joinWorkspacePath(resolvedArtifactDirectory, `${artifactStem}.${input.audioExtension}`)
    const audioPath = normalizeTranscribeArtifactPath(
      audioOptions.path ? await resolveArtifactValue(audioOptions.path, input) : defaultAudioPath,
      "artifacts.audio.path",
    )
    input = { ...input, audioPath }
    const mediaType = audioOptions.mediaType ? await resolveArtifactValue(audioOptions.mediaType, input) : audio.mediaType
    await context.workspace.fs.writeFile(audioPath as never, await audioBytes(audio, { maxBytes }), { mediaType })
  }

  if (transcriptOptions && transcriptPath) {
    const content = transcriptOptions.template
      ? await transcriptOptions.template(input)
      : transcriptOptions.format === "markdown"
        ? [
            "---",
            `created_at: ${input.createdAt}`,
            `audio: ${input.audioPath || ""}`,
            "---",
            "",
            transcript.trim(),
            "",
          ].join("\n")
        : `${transcript.trim()}\n`
    const transcriptMediaTypeExtension = pathExtension(transcriptPath)
    const mediaType = transcriptOptions.mediaType
      ? await resolveArtifactValue(transcriptOptions.mediaType, input)
      : transcriptOptions.format === "markdown" || transcriptMediaTypeExtension === "md" ? "text/markdown" : "text/plain"
    await context.workspace.fs.writeFile(transcriptPath as never, content, { mediaType })
  }

  return toTranscriptionResult(input)
}

function toTranscriptionResult(input: TranscribeArtifactTemplateInput): TranscriptionResult {
  return {
    ...(input.audioPath ? { audioPath: input.audioPath } : {}),
    createdAt: input.createdAt,
    date: input.date,
    messageId: input.messageId,
    stem: input.stem,
    transcript: input.transcript,
    ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
  }
}

function appendTranscriptionResults(store: AgentInvocationContextStore, results: TranscriptionResult[]) {
  if (!results.length) return
  const existing = store.get<TranscriptionResult[]>(TRANSCRIPTION_RESULTS_CONTEXT_KEY) || []
  store.set(TRANSCRIPTION_RESULTS_CONTEXT_KEY, [...existing, ...results])
}

function validateTranscriptionArtifactsWorkspace(context: AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>, artifacts: TranscribeArtifactsOptions | undefined) {
  if (artifacts && !isWritableWorkspace(context.workspace)) {
    throw new Error("[vitehub] transcribe({ artifacts }) requires workspace.mode: \"write\".")
  }
}

export function getTranscriptionResults(context: AgentInvocationContextStore | { context: AgentInvocationContextStore } | undefined): TranscriptionResult[] {
  const store = context && "context" in context ? context.context : context
  return store?.get<TranscriptionResult[]>(TRANSCRIPTION_RESULTS_CONTEXT_KEY) || []
}

export function transcribe(options: TranscribeOptions): AgentCapabilityDefinition {
  return defineCapability({
    id: "transcribe",
    metadata: {
      kind: "transcribe",
    },
    input: async (context) => {
      const messages = []
      const results: TranscriptionResult[] = []
      let resolvedOptions: StaticTranscribeOptions | undefined

      async function getResolvedOptions() {
        resolvedOptions ||= await resolveTranscribeOptions(options)
        return resolvedOptions
      }

      for (const message of context.input.messages()) {
        const audioParts = message.parts.filter(isAudioPart)
        if (!audioParts.length) {
          messages.push(message)
          continue
        }

        const resolved = await getResolvedOptions()
        const maxBytes = normalizeMaxBytes(resolved.maxBytes)
        validateTranscriptionArtifactsWorkspace(context as AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>, resolved.artifacts)
        const transcripts = await Promise.all(
          audioParts.map(part => runTranscription(resolved, part, context.input.get().abortSignal)),
        )
        const messageResults = await Promise.all(
          audioParts.map((part, index) => writeTranscriptionArtifacts(
            context as AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>,
            resolved.artifacts,
            message,
            part,
            transcripts[index] || "",
            index,
            audioParts.length,
            maxBytes,
          )),
        )
        results.push(...messageResults)
        const text = transcripts.filter(Boolean).join("\n")
        const separator = text && message.parts.some(part => part.type === "text" && part.text.length > 0) ? "\n" : ""
        messages.push(appendMessageText({
          ...message,
          parts: message.parts.filter(part => !isAudioPart(part)),
        }, `${separator}${text}`))
      }
      context.input.setMessages(messages)
      appendTranscriptionResults(context.context, results)
    },
    output(context) {
      context.finish.provide(() => {
        const results = getTranscriptionResults(context)
        return results.length ? results : undefined
      })
    },
    requires: typeof options === "function" ? undefined : options.artifacts ? [{ primitive: "workspace", workspace: { mode: "write", required: true } }] : undefined,
  })
}
