import { defineCapability } from "../capability-runtime.ts"
import { appendMessageText } from "../messages.ts"

import type {
  AgentCapabilityDefinition,
  MaybePromise,
} from "../types.ts"
import type { AudioPart } from "../messages.ts"

type AiSdkTranscribe = typeof import("ai")["experimental_transcribe"]
type AiSdkTranscribeOptions = Omit<Parameters<AiSdkTranscribe>[0], "abortSignal" | "audio">
type AiSdkTranscriptionResult = Awaited<ReturnType<AiSdkTranscribe>>

export interface TranscribeExecuteInput {
  audio: AudioPart
}

export type TranscribeExecuteResult = AiSdkTranscriptionResult | string

export type TranscribeOptions =
  | (AiSdkTranscribeOptions & { execute?: never, instructions?: AgentCapabilityDefinition["instructions"] })
  | { execute: (input: TranscribeExecuteInput) => MaybePromise<TranscribeExecuteResult>, instructions?: AgentCapabilityDefinition["instructions"], model?: never }

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

function transcriptText(result: TranscribeExecuteResult): string {
  return typeof result === "string" ? result : result.text
}

async function runTranscription(options: TranscribeOptions, audio: AudioPart, abortSignal?: AbortSignal): Promise<string> {
  if ("execute" in options && options.execute) {
    return transcriptText(await options.execute({ audio }))
  }

  const {
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

export function transcribe(options: TranscribeOptions): AgentCapabilityDefinition {
  return defineCapability({
    id: "transcribe",
    input: async (context) => {
      const messages = []
      for (const message of context.input.messages()) {
        const audioParts = message.parts.filter(isAudioPart)
        if (!audioParts.length) {
          messages.push(message)
          continue
        }

        const transcripts = await Promise.all(
          audioParts.map(part => runTranscription(options, part, context.input.get().abortSignal)),
        )
        const text = transcripts.filter(Boolean).join("\n")
        const separator = text && message.parts.some(part => part.type === "text" && part.text.length > 0) ? "\n" : ""
        messages.push(appendMessageText(message, `${separator}${text}`))
      }
      context.input.setMessages(messages)
    },
    instructions: options.instructions ?? false,
  })
}
