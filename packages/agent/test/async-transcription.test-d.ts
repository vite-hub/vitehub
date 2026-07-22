import { expectTypeOf, it } from "vitest"
import type { ViteHubError } from "@vite-hub/runtime"

import {
  createTranscription,
  elevenLabsScribe,
  type TranscriptionClient,
  type TranscriptionCompletion,
  type TranscriptionDriver,
  type TranscriptionErrorCode,
  type TranscriptionErrorDetails,
  type TranscriptionSubmission,
  type TranscriptionSubmitInput,
} from "../src/capabilities.ts"

declare const driver: TranscriptionDriver
declare const payload: unknown
declare const submitInput: TranscriptionSubmitInput
type TranscriptionFailure = ViteHubError<TranscriptionErrorCode, TranscriptionErrorDetails>
declare const transcriptionError: TranscriptionFailure

it("exports the asynchronous transcription contract", () => {
  expectTypeOf(createTranscription({ driver })).toEqualTypeOf<TranscriptionClient>()
  expectTypeOf(createTranscription({ driver }).submit(submitInput)).toEqualTypeOf<Promise<TranscriptionSubmission>>()
  expectTypeOf(createTranscription({ driver }).receive(payload)).toEqualTypeOf<Promise<TranscriptionCompletion>>()
  expectTypeOf(elevenLabsScribe({ apiKey: "secret", webhookId: "webhook-1" })).toEqualTypeOf<TranscriptionDriver>()
})

it("keeps transcription error details closed", () => {
  transcriptionError.details?.provider satisfies string | undefined
  // @ts-expect-error Transcription details do not expose arbitrary keys.
  transcriptionError.details?.token
})

it("keeps provider completion handling exhaustive", async () => {
  const completion = await createTranscription({ driver }).receive(payload)
  if (completion.status === "completed") {
    expectTypeOf(completion.transcript.text).toEqualTypeOf<string>()
  }
  else {
    expectTypeOf(completion.error).toEqualTypeOf<TranscriptionFailure>()
  }
})
