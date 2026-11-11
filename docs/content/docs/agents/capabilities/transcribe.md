---
title: Transcribe
description: Turn audio in user messages into text before your Agent runs. Stream live audio or send long files to a remote service.
navigation.title: Transcribe
navigation.order: 250
navigation.group: Capabilities
icon: i-lucide-audio-lines
---

`transcribe()` turns audio in user messages into text before the Agent runs, using an AI SDK transcription model or your `execute()` function. The Agent Driver gets the text instead of the audio. It adds no model tool. It can also save the transcript and audio as artifacts in a writable [Workspace](/docs/workspace), the Agent's files.

## Configure transcription

Give a model or an `execute()` function. This example keeps artifacts off, so it needs no writable Workspace.

```ts [server/agents/voice.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { transcribe } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    transcribe({
      model: transcriptionModel,
    }),
  ],
})
```

## How transcription works

Before the model runs, for each audio part it:

1. checks the maximum size
2. gets the audio from direct data, `fetchData`, or a URL
3. replaces the audio part with the transcript text in the user message

It records one `TranscriptionResult` per part in the Invocation (one Agent run) context, and as a finish extension that finish hooks read. Pass a function instead of options to choose options per run.

With `artifacts`, it writes the transcript and audio to the writable Workspace:

- Both are on by default. `artifacts.transcript: false` or `artifacts.audio: false` turns one off.
- `artifacts.directory` keeps them together.
- Generated paths share a cleaned timestamp and message stem.

```ts fragment
transcribe({
  model: transcriptionModel,
  artifacts: {
    directory: 'inputs/voice-notes',
    transcript: { format: 'markdown' },
  },
})
```

## Streaming transcription

`streamTranscription()` shows text while raw audio arrives. It wraps AI SDK streaming transcription and gives an append-only `textStream` you can pass to `event.reply()`.

```ts
import type { AgentFinishHookEvent } from 'vite-hub/agent'
import { streamTranscription } from 'vite-hub/agent/capabilities'

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

Do not await `transcription.text` first: reading the reply drives the stream that resolves it.

- Chat-backed Channels stream natively when the adapter supports it, else use Chat SDK's post-and-edit fallback.
- Other message Channels use their native stream method, else send one final reply.

Provider `transcript-delta` events become chunks. Providers that send only partial and final snapshots give one final reply, so corrected text does not repeat.

## Asynchronous remote transcription

`createTranscription()` handles long files that a provider transcribes in the background. A durable workflow submits a private remote file and continues when the provider finishes.

- `submit()` returns the provider operation ID, to acknowledge the callback and avoid duplicate work. It never downloads the file into your app.
- `receive()` turns an authenticated completion payload into a transcript or failure, with the same shape for every provider.

```ts fragment
import {
  createTranscription,
  elevenLabsScribe,
} from 'vite-hub/agent/capabilities'

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

For private Blob objects, use a signed HTTPS URL that outlives the provider's fetch.

Build the rest with the [Workflows primitive](/docs/workflows): authenticate the callback before `receive()`, store operation state durably, handle repeated callbacks and timeouts, and continue the workflow.

> [!WARNING]
> Do not trust correlation metadata until it matches the stored workflow attempt.

Provider payloads and SDK types stay inside the client. A failed completion has a `ViteHubError` with a fixed `TRANSCRIPTION_*` code and message. Raw provider diagnostics stay in the in-memory `cause` and are left out when serialized.

## Requirements

- Basic: `model` (with the `ai` package) or `execute`.
- Artifacts: an explicit writable Workspace, `workspace: { mode: 'write' }`.
- Streaming: an AI SDK streaming transcription model, a `ReadableStream<Uint8Array | string>` of raw audio, and the input format.
- Asynchronous: a `TranscriptionDriver`. The built-in ElevenLabs Scribe driver needs an explicit API key and speech-to-text webhook ID.

## Security and approval

`transcribe()` adds no tool, so there is no approval step. It sends input audio to the configured provider.

> [!WARNING]
> The server downloads audio parts that have only a URL. Accept audio URLs only from trusted sources.

- The built-in executor enforces `maxBytes`.
- A custom `execute` gets audio before ViteHub fetches or measures it, so it must limit direct data, `fetchData()` results, and downloads itself.
- Artifact paths must stay inside the Workspace and cannot use reserved `.git` or `.vitehub` paths.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets messages with the text. |
| Provider-backed | Gets Agent Run Input with the text. |
| Custom-run-backed | Gets Agent Run Input with the text, and results from context. |

Asynchronous transcription is Driver-independent: your code puts the operation and result in a durable Workflow.

## Verify transcription

1. Run with one audio part and check that the transcript is in the message before the Driver runs.
2. Check the finish extension for results.
3. With artifacts on, find the transcript and audio files in the Workspace.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | AI SDK transcription model | required unless `execute` is set | Transcription model. Other AI SDK `transcribe()` options, such as `providerOptions`, are forwarded. |
| `execute` | `({ audio }) => string \| result` | none | Custom function. Not with `model`. |
| `maxBytes` | `number` | `26214400` | Maximum accepted audio bytes. |
| `artifacts` | `object` | none | Save artifacts. Needs a writable Workspace. |
| `artifacts.directory` | `string \| function` | generated | Artifact directory. |
| `artifacts.transcript` | `false \| object` | on when `artifacts` is set | Save the transcript. |
| `artifacts.transcript.format` | `"text" \| "markdown"` | `"text"` | Default body and extension. |
| `artifacts.transcript.path` | `string \| function` | generated | Transcript artifact path. |
| `artifacts.transcript.mediaType` | `string \| function` | inferred | Transcript artifact media type. |
| `artifacts.transcript.template` | `function` | default text | Custom body. |
| `artifacts.audio` | `boolean \| object` | on when `artifacts` is set | Save the source audio. |
| `artifacts.audio.path` | `string \| function` | generated | Audio artifact path. |
| `artifacts.audio.mediaType` | `string \| function` | audio media type | Audio artifact media type. |

### Asynchronous client

| Interface | Result | Description |
| --- | --- | --- |
| `createTranscription({ driver })` | `TranscriptionClient` | Creates a provider-neutral asynchronous client. |
| `client.submit({ source, metadata, abortSignal })` | `submitted` operation | Submits a remote HTTP(S) source; returns the operation ID. |
| `client.receive(payload)` | `completed \| failed` completion | Normalizes an authenticated completion payload. |
| `elevenLabsScribe(options)` | `TranscriptionDriver` | Maps Scribe v2 submission and callback payloads, hiding provider types. |

Without `artifacts.directory`, transcripts go to `transcripts/<date>/<stem>.txt` with the audio beside them. With transcripts off, audio goes to `audio/<date>/<stem>.<extension>`.

### Public helpers

Import these from `vite-hub/agent/capabilities` when hooks or executors need the same data.

| Helper | Return value | Behavior |
| --- | --- | --- |
| `audioBytes(audio, { maxBytes? })` | `Promise<Uint8Array>` | Resolves direct data, `fetchData`, or a URL, with a `26214400` byte default limit. |
| `getTranscriptionResults(context)` | `TranscriptionResult[]` | The run's results from a context store or an object holding one, or an empty array. |
| `streamTranscription(options)` | `Promise<StreamingTranscription>` | Starts streaming transcription. Exposes `textStream`, the final `text`, and the underlying `result` metadata. |

Each `TranscriptionResult` has `createdAt`, `date`, `messageId`, `stem`, and `transcript`, plus `audioPath` or `transcriptPath` when written.

## Related pages

- [AI Gateway streaming transcription](https://vercel.com/changelog/ai-gateway-now-supports-streaming-transcription)
- [Workspace primitive](/docs/workspace)
- [Workflows primitive](/docs/workflows)
- [Agent invocations](/docs/agents/invocations)
- [Official capabilities](/docs/agents/capabilities/official)
