# Transcription Artifacts Use Workspace Paths

Transcription artifact persistence will be configured through `transcribe({ artifacts })`, not through a nested `workspace` option or generic `output` option. The Agent's top-level `workspace` remains the Colocated Workspace Definition and must request write mode when Transcription Artifacts are enabled.

`artifacts.transcript.path` is the Transcript Workspace Path: one exact Workspace path for the transcript artifact. Directory, stem, and extension are derived from that path rather than configured as separate public fields. The source audio artifact is controlled through `artifacts.audio`; when enabled without `artifacts.audio.path`, it is written beside the transcript with the same stem and inferred audio extension.

The default `stem` passed to artifact path callbacks is generated from the message timestamp and invocation message id, then sanitized for Workspace path use. This keeps common callbacks such as `inbox/${date}/${stem}.md` safe when chat platforms provide ids with punctuation.

## Considered Options

- Keeping `transcribe({ workspace })` was rejected because it made artifact persistence look like a Workspace Definition. Capabilities consume declared Workspace access; they do not define the Workspace boundary.
- Keeping `transcribe({ output })` was rejected because `output.path` reads like a generic destination even though it only names the transcript artifact. Source audio is also first-class persistence, so transcript and audio should be peer artifact configs.
- Naming the option `transcription` was rejected because it names the capability result, not persistence. The transcript is already exposed to the Agent run and through `getTranscriptionResults`; persistence needs artifact language.
- Keeping separate `directory`, `stem`, and `extension` fields was rejected because it preserves two destination models and recreates the original split the API is meant to remove.
- Treating provider response format and file media type as one option was rejected. Provider transcription options stay provider-specific; Transcription Artifacts media type is inferred from each artifact path or set with artifact-level `mediaType`.
- Making audio persistence implicit with no controls was rejected because source audio is a separate artifact, not the transcript artifact itself.
- Automatically sending the transcript back to the user was kept separate from persistence. Developers can return `getTranscriptionResults(context)` from the Agent run today; a future reply helper should not be coupled to Workspace artifacts.

## Consequences

Transcription Artifacts require a writable Workspace and write normal Workspace paths, so Workspace Rules and path safety remain enforced at the Workspace boundary.

The public shape is optimized for the final design rather than compatibility:

```ts
transcribe({
  artifacts: {
    audio: false,
    transcript: {
      path: ({ date, stem }) => `inbox/${date}/${stem}.md`,
      template: ({ audioPath, transcript }) => `${audioPath ?? ""}\n${transcript}`,
    },
  },
})
```

`artifacts.transcript.path` must be described as the transcript Workspace path, not as a generic output directory or all-artifacts path. If audio is enabled and `artifacts.audio.path` is omitted, the audio artifact path is derived from the transcript path.

Future transcript formats, raw provider JSON, subtitles, or alternative media storage should add explicit fields rather than overloading `artifacts.transcript.path`.
