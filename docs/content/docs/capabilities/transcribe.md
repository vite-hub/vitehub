---
title: Transcribe
description: Convert audio input parts into transcript text before an Agent runs.
navigation.title: Transcribe
navigation.order: 150
navigation.group: External context
icon: i-lucide-audio-lines
---

`transcribe()` is an input-phase Official Capability for audio.
It turns audio message parts into transcript text before the Agent Driver receives the final input.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability finds audio parts in input messages, transcribes them, appends transcript text to the message, and records transcription results in invocation context.
It can also persist transcript and source-audio artifacts into a writable Workspace.

## Configuration

Provide either an AI SDK transcription model configuration or an `execute()` function.
The example keeps artifacts off, so it does not require a writable Workspace.

```ts [server/agents/voice.ts]
import { defineAgent } from '@vite-hub/agent'
import { transcribe } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    transcribe({
      model: transcriptionModel,
    }),
  ],
})
```

## Runtime behavior

`transcribe()` runs before model execution.
It enforces the configured maximum audio size, resolves audio data from direct data, `fetchData`, or URL, and replaces the consumed audio parts with transcript text in the user message.

When artifacts are enabled, it writes sanitized transcript and optional audio files to the Agent's writable Workspace and exposes results as a finish extension.

Use `artifacts.directory` when the transcript and source audio should stay together.
The generated paths share a sanitized timestamp/message stem.

```ts
transcribe({
  model: transcriptionModel,
  artifacts: {
    directory: 'inputs/voice-notes',
    transcript: { format: 'markdown' },
  },
})
```

## Streaming transcription

Use `streamTranscription()` for live raw audio. It wraps AI SDK streaming transcription and exposes `textStream`, an append-only text stream that can be passed directly to `event.reply()`.

```ts
import type { AgentFinishHookEvent } from '@vite-hub/agent'
import { streamTranscription } from '@vite-hub/agent/capabilities'

export async function liveTranscriptReply(
  event: AgentFinishHookEvent,
  audio: ReadableStream<Uint8Array>,
) {
  const transcription = await streamTranscription({
    model: 'openai/gpt-realtime-whisper',
    audio,
    inputAudioFormat: {
      type: 'audio/pcm',
      rate: 24_000,
    },
  })

  return event.reply(transcription.textStream)
}
```

Return the reply intent without awaiting `transcription.text`; consuming the reply drives the provider stream and resolves the final text promise. Chat-backed Channels use native streaming when the adapter supports it and Chat SDK's post-and-edit fallback otherwise. Other message Channels use their native stream method when available and fall back to one final reply.

`streamTranscription()` emits provider `transcript-delta` events as reply chunks. Providers that only emit partial and final snapshots produce one final reply, which avoids duplicating corrected partial text.

## Asynchronous remote transcription

Use `createTranscription()` when a durable workflow should submit a private remote object and resume after the provider completes it.
The client returns the provider operation ID used for acknowledgement and idempotency, then normalizes an authenticated completion payload into a provider-neutral transcript or failure.

```ts
import {
  createTranscription,
  elevenLabsScribe,
} from '@vite-hub/agent/capabilities'

const transcription = createTranscription({
  driver: elevenLabsScribe({
    apiKey: () => env.ELEVENLABS_API_KEY,
    diarize: true,
    tagAudioEvents: true,
    timestampsGranularity: 'word',
    webhookId: env.ELEVENLABS_WEBHOOK_ID,
  }),
})

const submission = await transcription.submit({
  metadata: { attemptId, jobId },
  source: { url: signedAudioUrl },
})

const completion = await transcription.receive(authenticatedProviderPayload)

if (completion.status === 'failed') {
  console.error(completion.error.code, completion.error.message)
}
```

`submit()` never downloads the remote object into the application process.
Use a signed HTTPS URL for private Blob objects, with an expiry long enough for the provider to fetch it.

The caller still owns callback authentication before `receive()`, durable operation state, duplicate-delivery handling, timeouts, and workflow resumption.
Compose those concerns with the Workflow primitive; correlation metadata is untrusted until it matches the stored workflow attempt.
Provider callback payloads and SDK types do not cross the transcription client interface.
Failed completions contain a `ViteHubError` with a fixed `TRANSCRIPTION_*` code and message. Raw provider diagnostics stay behind the in-memory `cause` and are omitted when the completion is serialized.

## Requirements

Basic transcription requires a model or custom executor.
Artifact persistence requires an explicit writable Workspace.

Streaming transcription requires an AI SDK streaming transcription model, a `ReadableStream<Uint8Array | string>` of raw audio, and its input audio format.

Asynchronous remote transcription requires a `TranscriptionDriver`.
The built-in ElevenLabs Scribe driver requires an API key and an explicitly configured speech-to-text webhook ID.

Audio data must stay within `maxBytes`.
Artifact paths must stay inside the Workspace and cannot target reserved `.git` or `.vitehub` paths.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives text-enriched messages after transcription. |
| Provider-backed | Receives text-enriched Agent Run Input before provider execution. |
| Custom-run-backed | Receives text-enriched Agent Run Input and can read transcription results from context. |

Asynchronous transcription is independent of the Agent Driver because the caller composes its submitted operation and completion result into a durable Workflow.

## Inspect and verify

Run an invocation with one audio part and inspect the final message text.
The transcript should appear before the Agent Driver runs.

When artifacts are enabled, inspect the Workspace for transcript files and the finish extension for transcription metadata.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | AI SDK transcription model | required unless `execute` is set | Model used by AI SDK transcription. |
| `execute` | `(input) => string \| result` | none | Custom transcription function; mutually exclusive with `model`. |
| `maxBytes` | `number` | `26214400` | Maximum accepted audio bytes. |
| `artifacts.directory` | `string \| function` | generated | Directory for generated transcript and audio artifacts. |
| `artifacts.transcript` | `false \| object` | disabled | Persist transcript artifacts to Workspace. |
| `artifacts.transcript.format` | `"text" \| "markdown"` | `"text"` | Default transcript artifact body and generated extension. |
| `artifacts.transcript.path` | `string \| function` | generated | Transcript artifact path. |
| `artifacts.transcript.mediaType` | `string \| function` | inferred | Transcript artifact media type. |
| `artifacts.transcript.template` | `function` | default text | Custom transcript artifact body. |
| `artifacts.audio` | `boolean \| object` | disabled | Persist source audio artifacts to Workspace. |
| `artifacts.audio.path` | `string \| function` | generated | Audio artifact path. |
| `artifacts.audio.mediaType` | `string \| function` | audio media type | Audio artifact media type. |

### Asynchronous client

| Interface | Result | Description |
| --- | --- | --- |
| `createTranscription({ driver })` | `TranscriptionClient` | Creates a provider-neutral asynchronous client. |
| `client.submit({ source, metadata, abortSignal })` | `submitted` operation | Submits a remote HTTP(S) source and returns the provider operation ID. |
| `client.receive(payload)` | `completed \| failed` completion | Normalizes an already-authenticated provider completion payload. |
| `elevenLabsScribe(options)` | `TranscriptionDriver` | Maps remote Scribe v2 submission and callback payloads without exposing provider types. |

Without `artifacts.directory`, transcripts use `transcripts/<date>/<stem>.txt` and audio is placed beside the transcript. If transcripts are disabled, audio uses `audio/<date>/<stem>.<extension>`.

## Public helpers

Import these helpers from `@vite-hub/agent/capabilities` when custom hooks or executors need the same normalized data as the Capability.

| Helper | Return value | Behavior |
| --- | --- | --- |
| `audioBytes(audio, { maxBytes? })` | `Promise<Uint8Array>` | Resolves direct data, `fetchData`, or an audio URL and enforces a `26214400` byte default limit. |
| `getTranscriptionResults(context)` | `TranscriptionResult[]` | Reads the current invocation's results from an invocation context store or an object containing one. Returns an empty array when none exist. |
| `streamTranscription(options)` | `Promise<StreamingTranscription>` | Starts AI SDK streaming transcription and exposes `textStream` for streamed replies, `text` for the final transcript, and the underlying `result` metadata. |

Each `TranscriptionResult` contains `createdAt`, `date`, `messageId`, `stem`, and `transcript`, plus `audioPath` or `transcriptPath` when those artifacts were written.

## Reference

- [AI Gateway streaming transcription](https://vercel.com/changelog/ai-gateway-now-supports-streaming-transcription)
- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent invocations](/docs/agents/invocations)
- Source: `packages/agent/src/capabilities/transcribe.ts`
