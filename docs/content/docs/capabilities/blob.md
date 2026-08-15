---
title: Blob
description: Expose scoped Blob read and optional edit tools to an Agent.
navigation.title: Blob
navigation.order: 80
navigation.group: Runtime primitives
icon: i-lucide-file-box
---

`blob()` adds model-facing tools for a configured ViteHub Blob primitive.
It exposes object read, metadata, and list operations by default, then adds edits only in write mode.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability contributes `blob_read` for get, head, and list operations.
When configured with write mode, it also contributes `blob_edit` for putting or deleting objects.
`blob_edit` can upload inline content, a current input attachment through `attachmentId`, or a Workspace file through `workspacePath`.
For Provider Agents, `assetPaths` also turns final-answer Markdown references into published delivery artifacts.

## Configuration

Attach Blob in read mode until the Agent needs to write objects.
The Blob primitive must already be configured by the app.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { blob } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    blob({ mode: 'read' }),
  ],
})
```

## Runtime behavior

ViteHub selects the configured Blob store and exposes a small Storage Capability Tool Surface.
Read mode supports one object read, metadata read, or prefix list operation per tool call.
Write mode adds put/delete operations and allows them by default.
Put operations accept exactly one of `attachmentId`, `body`, or `workspacePath`.
Delete operations return `{ pathname, deleted: true }`.

## Requirements

`blob()` uses the configured `blob` primitive when present, or the default export from an installed `@vite-hub/blob` package.
Named store selection requires the Blob primitive to expose store selection.

Writes require explicit write mode.
Set `policy: 'require-approval'` or `policy: 'deny'` when the product needs an additional gate.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `blob_read` and, in write mode, `blob_edit`. |
| Provider-backed | Receives the Capability tools. In write mode, `assetPaths` also publishes current-run files referenced by the final Markdown. |
| Custom-run-backed | The configured primitive is available through runtime context; `driver.run` decides how to use it. |

## Inspect and verify

Run `vitehub agent info --agent <name> --json` and inspect the resolved tool list.
Read mode should show only `blob_read`; write mode should also show `blob_edit` with the configured policy.

Run one invocation against a missing Blob primitive during development.
The Capability should fail before exposing tools.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Adds `blob_edit` when set to `"write"`. |
| `assetPaths` | `boolean \| string \| string[]` | `false` | Materializes Provider asset paths and publishes current-run files explicitly referenced by final Markdown. `true` uses `screenshots`. |
| `store` | `string` | default store | Selects a named Blob store when the Blob primitive supports `store()`. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for `blob_edit`. |

## Provider artifacts

Declare the directories where a Provider Agent may write public artifacts. The Agent can use its normal filesystem workflow, then reference a generated file in its final answer.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { blob } from '@vite-hub/agent/capabilities'
import { github } from '@vite-hub/agent/channels'

export default defineAgent({
  capabilities: [
    blob({ assetPaths: ['artifacts'], mode: 'write', policy: 'deny' }),
  ],
  channels: {
    github: github({ pullRequest: true }),
  },
  driver: 'codex',
  workspace: { mode: 'write' },
})
```

If Codex adds `![Preview](artifacts/preview.png)` to its final answer, ViteHub publishes the file through Blob, records it in `AgentRunResult.artifacts`, and rewrites that exact Markdown destination during Channel delivery.

Publication is deliberately bounded. ViteHub accepts only Markdown links or images under `assetPaths`, intersects them with files added or modified by the current Provider Workspace write-back, and ignores bare paths, stale files, removed files, and paths outside the declared roots. `policy` still controls the model-facing `blob_edit` tool; host-owned artifact publication does not require that tool to be enabled.

Configure Blob serving or a Blob driver that returns public URLs. When `blob.serve` returns a route-relative URL, Agent delivery resolves it against the invocation request URL.

## Workspace uploads

Use `workspacePath` when another Capability writes an artifact into the Workspace and the Agent should upload that file to Blob storage.
The path is Workspace-relative.

```ts [Agent tool call]
await blob_edit({
  operation: 'put',
  pathname: 'review/screenshots/home.png',
  workspacePath: 'screenshots/home.png',
  options: { contentType: 'image/png' },
})
```

## Reference

- [Blob primitive](/docs/server-primitives/blob)
- [Official capabilities](/docs/capabilities/official-capabilities)
- Source: `packages/agent/src/capabilities/storage/blob.ts`
