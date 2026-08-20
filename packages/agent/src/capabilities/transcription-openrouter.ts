import { loadAiSdk } from "../internal/ai-sdk-runtime.ts"
import { audioExtensionFor } from "./transcribe.ts"

import type { MaybePromise } from "../types.ts"
import type { TranscriptionModel } from "ai"

type OpenRouterTranscriptionModel = Extract<TranscriptionModel, { specificationVersion: "v4" }>
type AiSdk = typeof import("ai")

export interface OpenRouterTranscriptionModelOptions {
  apiKey: string | (() => MaybePromise<string>)
  model: string
}

interface OpenRouterTranscriptionResponse {
  error?: { message?: unknown }
  language?: unknown
  text?: unknown
  usage?: { seconds?: unknown }
}

interface OpenRouterTranscriptionProviderOptions {
  language?: string
  provider?: Record<string, unknown>
  temperature?: number
}

const endpoint = "https://openrouter.ai/api/v1/audio/transcriptions"

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function responseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries())
}

function providerOptions(value: unknown): OpenRouterTranscriptionProviderOptions {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("[vitehub] OpenRouter transcription provider options must be an object.")
  }
  const options = value as Record<string, unknown>
  const unsupported = Object.keys(options).filter(key => !["language", "provider", "temperature"].includes(key))
  if (unsupported.length) {
    throw new TypeError(`[vitehub] Unsupported OpenRouter transcription provider option: ${unsupported.join(", ")}.`)
  }
  if (options.language !== undefined && !nonEmptyString(options.language)) {
    throw new TypeError("[vitehub] OpenRouter transcription language must be a non-empty string.")
  }
  if (options.temperature !== undefined && (typeof options.temperature !== "number" || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)) {
    throw new TypeError("[vitehub] OpenRouter transcription temperature must be between 0 and 1.")
  }
  if (options.provider !== undefined && (!options.provider || typeof options.provider !== "object" || Array.isArray(options.provider))) {
    throw new TypeError("[vitehub] OpenRouter transcription provider routing options must be an object.")
  }
  return options as OpenRouterTranscriptionProviderOptions
}

async function resolveApiKey(value: OpenRouterTranscriptionModelOptions["apiKey"], aiSdk: AiSdk): Promise<string> {
  const apiKey = typeof value === "function" ? await value() : value
  if (!nonEmptyString(apiKey)) {
    throw new aiSdk.LoadAPIKeyError({ message: "OpenRouter transcription requires an API key." })
  }
  return apiKey
}

export function openRouterTranscriptionModel(options: OpenRouterTranscriptionModelOptions): OpenRouterTranscriptionModel {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] openRouterTranscriptionModel() requires options.")
  }
  if (typeof options.apiKey !== "string" && typeof options.apiKey !== "function") {
    throw new TypeError("[vitehub] openRouterTranscriptionModel({ apiKey }) requires a string or resolver.")
  }
  if (!nonEmptyString(options.model)) {
    throw new TypeError("[vitehub] openRouterTranscriptionModel({ model }) requires a non-empty model id.")
  }

  return {
    modelId: options.model,
    provider: "openrouter.transcription",
    specificationVersion: "v4",
    async doGenerate(input) {
      const aiSdk = await loadAiSdk()
      const openrouter = providerOptions(input.providerOptions?.openrouter)
      const format = audioExtensionFor(input.mediaType, "")
      if (!format) throw new TypeError(`[vitehub] OpenRouter transcription does not support ${input.mediaType}.`)
      const body = {
        input_audio: {
          data: aiSdk.convertDataContentToBase64String(input.audio),
          format,
        },
        model: options.model,
        ...openrouter,
        response_format: "json",
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(input.headers || {})) {
        if (value !== undefined) headers.set(name, value)
      }
      headers.set("authorization", `Bearer ${await resolveApiKey(options.apiKey, aiSdk)}`)
      headers.set("content-type", "application/json")

      let response: Response
      try {
        response = await fetch(endpoint, {
          body: JSON.stringify(body),
          headers,
          method: "POST",
          signal: input.abortSignal,
        })
      }
      catch (cause) {
        if (input.abortSignal?.aborted) throw cause
        throw new aiSdk.APICallError({
          cause,
          isRetryable: true,
          message: "OpenRouter transcription request failed.",
          requestBodyValues: { model: options.model, response_format: "json" },
          url: endpoint,
        })
      }

      let responseText: string
      try {
        responseText = await response.text()
      }
      catch (cause) {
        if (input.abortSignal?.aborted) throw cause
        throw new aiSdk.APICallError({
          cause,
          isRetryable: true,
          message: "OpenRouter transcription response failed.",
          requestBodyValues: { model: options.model, response_format: "json" },
          responseHeaders: responseHeaders(response),
          statusCode: response.status,
          url: endpoint,
        })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(responseText)
      }
      catch (cause) {
        if (!response.ok) {
          throw new aiSdk.APICallError({
            cause,
            message: `OpenRouter transcription failed with ${response.status}.`,
            requestBodyValues: { model: options.model, response_format: "json" },
            responseBody: responseText,
            responseHeaders: responseHeaders(response),
            statusCode: response.status,
            url: endpoint,
          })
        }
        throw new aiSdk.InvalidResponseDataError({ data: responseText })
      }
      const result = parsed && typeof parsed === "object"
        ? parsed as OpenRouterTranscriptionResponse
        : undefined

      if (!response.ok) {
        throw new aiSdk.APICallError({
          message: nonEmptyString(result?.error?.message)
            ? result.error.message
            : `OpenRouter transcription failed with ${response.status}.`,
          requestBodyValues: { model: options.model, response_format: "json" },
          responseBody: responseText,
          responseHeaders: responseHeaders(response),
          statusCode: response.status,
          url: endpoint,
        })
      }
      if (typeof result?.text !== "string") throw new aiSdk.InvalidResponseDataError({ data: parsed })

      return {
        durationInSeconds: typeof result.usage?.seconds === "number" ? result.usage.seconds : undefined,
        language: nonEmptyString(result.language) ? result.language : undefined,
        response: {
          body: result,
          headers: responseHeaders(response),
          modelId: options.model,
          timestamp: new Date(),
        },
        segments: [],
        text: result.text,
        warnings: [],
      }
    },
  }
}
