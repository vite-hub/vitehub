import { defineCapability } from "../capability-runtime.ts"
import { appendMessageText } from "../messages.ts"

import type {
  AgentCapabilityRuntimeContext,
  AgentCapabilityDefinition,
  AgentInvocationContextStore,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { AudioPart, Message } from "../messages.ts"
import type { WritableWorkspaceFacade, WorkspaceContent, WorkspaceName } from "@vitehub/workspace"

type AiSdkTranscribe = typeof import("ai")["experimental_transcribe"]
type AiSdkTranscribeOptions = Omit<Parameters<AiSdkTranscribe>[0], "abortSignal" | "audio">
type AiSdkTranscriptionResult = Awaited<ReturnType<AiSdkTranscribe>>
type TranscribeArtifactValue<T, TInput> = T | ((input: TInput) => MaybePromise<T>)

export interface TranscribeExecuteInput {
  audio: AudioPart
}

export type TranscribeExecuteResult = AiSdkTranscriptionResult | string

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
  mediaType?: TranscribeArtifactValue<string | undefined, TranscribeArtifactTemplateInput>
  path?: TranscribeArtifactValue<string, TranscribeArtifactTemplateInput>
  template?: (input: TranscribeArtifactTemplateInput) => MaybePromise<WorkspaceContent>
}

export interface TranscribeArtifactsOptions {
  audio?: boolean | TranscribeAudioArtifactOptions
  transcript?: false | TranscribeTranscriptArtifactOptions
}

export const TRANSCRIPTION_RESULTS_CONTEXT_KEY = "transcribe.results"

type StaticTranscribeOptions =
  | (AiSdkTranscribeOptions & {
    artifacts?: TranscribeArtifactsOptions
    execute?: never
    instructions?: AgentCapabilityDefinition["instructions"]
  })
  | {
    artifacts?: TranscribeArtifactsOptions
    execute: (input: TranscribeExecuteInput) => MaybePromise<TranscribeExecuteResult>
    instructions?: AgentCapabilityDefinition["instructions"]
    model?: never
  }

export type TranscribeOptions = StaticTranscribeOptions | (() => MaybePromise<StaticTranscribeOptions>)

function isAudioPart(part: unknown): part is AudioPart {
  return !!part
    && typeof part === "object"
    && (part as { type?: unknown }).type === "audio"
    && typeof (part as { mediaType?: unknown }).mediaType === "string"
}

async function toAiSdkAudio(audio: AudioPart): Promise<Parameters<AiSdkTranscribe>[0]["audio"]> {
  if (audio.url) return new URL(audio.url)
  if (audio.data instanceof Blob) return await audio.data.arrayBuffer()
  if (audio.data) return audio.data
  throw new TypeError("[vitehub] transcribe() requires audio data or url.")
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

export async function audioBytes(audio: AudioPart): Promise<Uint8Array> {
  if (audio.data instanceof Blob) return new Uint8Array(await audio.data.arrayBuffer())
  if (audio.data instanceof ArrayBuffer) return new Uint8Array(audio.data)
  if (ArrayBuffer.isView(audio.data)) return new Uint8Array(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength)
  if (typeof audio.data === "string") return bytesFromAudioString(audio.data)
  if (audio.url) {
    const response = await fetch(audio.url)
    if (!response.ok) throw new Error(`[vitehub] Failed to download audio: ${response.status} ${response.statusText}.`)
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new TypeError("[vitehub] transcribe() requires audio data or url.")
}

function transcriptText(result: TranscribeExecuteResult): string {
  return typeof result === "string" ? result : result.text
}

async function resolveTranscribeOptions(options: TranscribeOptions): Promise<StaticTranscribeOptions> {
  return typeof options === "function" ? await options() : options
}

async function runTranscription(options: StaticTranscribeOptions, audio: AudioPart, abortSignal?: AbortSignal): Promise<string> {
  if ("execute" in options && options.execute) {
    return transcriptText(await options.execute({ audio }))
  }

  const {
    artifacts: _artifacts,
    instructions: _instructions,
    ...transcribeOptions
  } = options
  const { experimental_transcribe } = await import("ai")
  const result = await experimental_transcribe({
    ...transcribeOptions,
    abortSignal,
    audio: await toAiSdkAudio(audio),
  })
  return result.text
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

function defaultStem(input: Pick<TranscribeArtifactTemplateInput, "audioCount" | "audioIndex" | "createdAt" | "messageId">): string {
  const suffix = input.audioCount > 1 ? `-${input.audioIndex + 1}` : ""
  return `${input.createdAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")}-${input.messageId}${suffix}`
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
  const defaultTranscriptPath = joinWorkspacePath("transcripts", input.date, `${input.stem}.txt`)
  const transcriptPath = transcriptOptions
    ? normalizeTranscribeArtifactPath(
        transcriptOptions.path ? await resolveArtifactValue(transcriptOptions.path, input) : defaultTranscriptPath,
        "artifacts.transcript.path",
      )
    : undefined

  if (transcriptPath)
    input = { ...input, transcriptPath }
  const artifactDirectory = transcriptPath ? pathDirectory(transcriptPath) : joinWorkspacePath("audio", input.date)
  const artifactStem = transcriptPath ? pathStem(transcriptPath) || input.stem : input.stem

  if (audioOptions) {
    const defaultAudioPath = joinWorkspacePath(artifactDirectory, `${artifactStem}.${input.audioExtension}`)
    const audioPath = normalizeTranscribeArtifactPath(
      audioOptions.path ? await resolveArtifactValue(audioOptions.path, input) : defaultAudioPath,
      "artifacts.audio.path",
    )
    input = { ...input, audioPath }
    const mediaType = audioOptions.mediaType ? await resolveArtifactValue(audioOptions.mediaType, input) : audio.mediaType
    await context.workspace.fs.writeFile(audioPath as never, await audioBytes(audio), { mediaType })
  }

  if (transcriptOptions && transcriptPath) {
    const content = transcriptOptions.template ? await transcriptOptions.template(input) : `${transcript.trim()}\n`
    const transcriptMediaTypeExtension = pathExtension(transcriptPath)
    const mediaType = transcriptOptions.mediaType
      ? await resolveArtifactValue(transcriptOptions.mediaType, input)
      : transcriptMediaTypeExtension === "md" ? "text/markdown" : "text/plain"
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

export function getTranscriptionResults(context: AgentInvocationContextStore | { context: AgentInvocationContextStore } | undefined): TranscriptionResult[] {
  const store = context && "context" in context ? context.context : context
  return store?.get<TranscriptionResult[]>(TRANSCRIPTION_RESULTS_CONTEXT_KEY) || []
}

export function transcribe(options: TranscribeOptions): AgentCapabilityDefinition {
  return defineCapability({
    id: "transcribe",
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
          )),
        )
        results.push(...messageResults)
        const text = transcripts.filter(Boolean).join("\n")
        const separator = text && message.parts.some(part => part.type === "text" && part.text.length > 0) ? "\n" : ""
        messages.push(appendMessageText(message, `${separator}${text}`))
      }
      context.input.setMessages(messages)
      appendTranscriptionResults(context.context, results)
    },
    instructions: typeof options === "function" ? false : options.instructions ?? false,
    requires: typeof options === "function" ? undefined : options.artifacts ? [{ primitive: "workspace", workspace: { mode: "write", required: true } }] : undefined,
  })
}
