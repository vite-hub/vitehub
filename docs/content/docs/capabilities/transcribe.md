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
It enforces the configured maximum audio size, resolves audio data from direct data, `fetchData`, or URL, and appends transcript text to the user message.

When artifacts are enabled, it writes sanitized transcript and optional audio files to the Agent's writable Workspace and exposes results as a finish extension.

## Requirements

Basic transcription requires a model or custom executor.
Artifact persistence requires an explicit writable Workspace.

Audio data must stay within `maxBytes`.
Artifact paths must stay inside the Workspace and cannot target reserved `.git` or `.vitehub` paths.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives text-enriched messages after transcription. |
| Harness-backed | Receives text-enriched Agent Run Input before harness execution. |
| Custom-run-backed | Receives text-enriched Agent Run Input and can read transcription results from context. |

## Inspect and verify

Run an invocation with one audio part and inspect the final message text.
The transcript should appear before the Agent Driver runs.

When artifacts are enabled, inspect the Workspace for transcript files and the finish extension for transcription metadata.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | AI SDK transcription model | required unless `execute` is set | Model used by AI SDK transcription. |
| `execute` | `(input) => string \| result` | none | Custom transcription function; mutually exclusive with `model`. |
| `instructions` | `string \| instruction blocks` | none | Instructions for transcription behavior. |
| `maxBytes` | `number` | `26214400` | Maximum accepted audio bytes. |
| `artifacts.transcript` | `false \| object` | disabled | Persist transcript artifacts to Workspace. |
| `artifacts.transcript.path` | `string \| function` | generated | Transcript artifact path. |
| `artifacts.transcript.mediaType` | `string \| function` | inferred | Transcript artifact media type. |
| `artifacts.transcript.template` | `function` | default text | Custom transcript artifact body. |
| `artifacts.audio` | `boolean \| object` | disabled | Persist source audio artifacts to Workspace. |
| `artifacts.audio.path` | `string \| function` | generated | Audio artifact path. |
| `artifacts.audio.mediaType` | `string \| function` | audio media type | Audio artifact media type. |

## Reference

- [Workspace primitive](/docs/server-primitives/workspace)
- [Agent invocations](/docs/agents/invocations)
- Source: `packages/agent/src/capabilities/transcribe.ts`
