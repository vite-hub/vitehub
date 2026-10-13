---
title: Blob capability
description: Give an Agent a Blob read tool and, in write mode, a tool that puts or deletes objects.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-file-box
---

`blob()` gives an Agent the `blob_read` tool for get, head, and list operations. In write mode, it also gives the `blob_edit` tool for put and delete operations.
Both tools call the configured [Blob primitive](/docs/blob). For Provider-backed Agents, `assetPaths` also publishes files that the final answer references.
The [Blob server API](/docs/blob/server-api) covers application code. This page covers the Agent tools.

## Configure Blob access

Attach Blob in read mode until the Agent must write objects.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { blob } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    blob({ mode: 'read' }),
  ],
})
```

## Agent-visible tool contract

These definitions are resolved from the real Capability during the docs build.

### Read mode

::agent-capability-tools{name="blob" variant="read"}
::

### Write mode

::agent-capability-tools{name="blob" variant="write"}
::

## How Blob access works

The Capability resolves the Blob store when the Agent calls a tool, not when the tools are listed. With `store`, it calls `store(name)` on the Blob handle.

`blob_read` runs one operation for each call:

- `get` returns the object at `pathname`.
- `head` returns the metadata of the object at `pathname`.
- `list` requires a non-empty `prefix`. It passes `cursor`, `folded`, and `limit` to the Blob handle. `limit` defaults to 25. Values above 100 are reduced to 100.

`blob_edit` runs one operation for each call:

- `put` writes to `pathname` from exactly one source: inline `body`, a current input attachment (`attachmentId`), or a Workspace file (`workspacePath`). `options` passes write options, such as `contentType`, to the Blob handle. For an attachment, the attachment media type replaces `options.contentType`.
- `delete` removes the object at `pathname` and returns `{ pathname, deleted: true }`.

When the current input has attachments, the `blob_edit` description lists their IDs and media types.

## Provider artifacts

Declare the directories where a Provider-backed Agent may write public artifacts. The Agent uses its normal filesystem workflow, then references a generated file in its final answer.

```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'
import { blob } from 'vite-hub/agent/capabilities'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  capabilities: [
    blob({ assetPaths: ['artifacts'], mode: 'write', policy: 'deny' }),
  ],
  channels: {
    github: github({ pullRequest: true }),
  },
  driver: 'codex',
  workspace: { commit: true, mode: 'write' },
})
```

If Codex adds `![Preview](artifacts/preview.png)` to its final answer, ViteHub publishes the file through Blob under a `vitehub-agent-artifacts/` prefix, records it in `AgentRunResult.artifacts`, and rewrites that exact Markdown destination in the final text.

Publication is bounded:

- `assetPaths` applies only in write mode and only to Provider-backed Drivers. In read mode, ViteHub ignores it.
- Each path must be Workspace-relative and must not contain `.` or `..` segments. `assetPaths: true` uses `screenshots`.
- ViteHub accepts only Markdown links or images under `assetPaths`. It publishes only files that the current Provider Workspace write-back added or modified. It ignores bare paths, stale files, removed files, and paths outside the declared roots.
- `policy` controls only the model-facing `blob_edit` tool. Host-owned artifact publication does not need that tool. The example sets `policy: 'deny'`, so the Agent cannot call `blob_edit`, but artifacts are still published.

Configure Blob serving or a Blob driver that returns public URLs. Publication fails when `put()` returns no `url`. When `blob.serve` returns a route-relative URL, ViteHub resolves it against the Agent Invocation request URL.

## Workspace uploads

Use `workspacePath` to upload a Workspace file, for example a screenshot that another Capability wrote. The path is Workspace-relative. The Capability reads from the active Agent Workspace Session first, then from the Workspace file system.

```ts [Agent tool call]
await blob_edit({
  operation: 'put',
  pathname: 'review/screenshots/home.png',
  workspacePath: 'screenshots/home.png',
  options: { contentType: 'image/png' },
})
```

## Requirements

- Configure the Blob primitive. Generated Agent routes pass `blob` from `@vite-hub/blob` to the Capability when the Blob Vite integration is active.
- Without a `blob` handle, the Capability imports `blob` from an installed `@vite-hub/blob` package. If that import fails, the first tool call fails. The tools are listed before this check.
- `store` requires a Blob handle that exposes `store()`.
- `workspacePath` requires a Workspace file system or an active Agent Workspace Session.

## Security and approval

- Read mode lets the Agent get and inspect any pathname, and list objects under any non-empty prefix, in the selected store. The `prefix` description says "developer-provided prefix", but the Capability does not enforce a prefix scope. To limit what the Agent can see, select a dedicated store with `store`.
- Write mode lets the Agent put or delete any pathname in the selected store. It can upload current input attachments and Workspace files.
- `policy` applies only to `blob_edit`. `blob_read` has no policy gate.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that receives `{ name, input }` and returns one of these values.
- Without `policy`, `blob_edit` runs when the Agent calls it.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The write runs only after approval. See [Runtime policy, approvals, and traces](/docs/agents/runtime-policy).
- Published artifacts get public URLs. Declare only `assetPaths` whose files may be public.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `blob_read` and, in write mode, `blob_edit`. `assetPaths` has no effect. |
| Provider-backed | Receives the same tools through the provider MCP bridge. In write mode, `assetPaths` also publishes current-run files that the final Markdown references. |
| Custom-run-backed | `driver.run` receives the tools in `context.tools` and decides whether to call them. `assetPaths` has no effect. |

## Verify Blob access

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`. Confirm that `tools` contains an entry with `name: "blob"`. Inspection lists one entry for each Capability, not one entry for each tool.
3. Run `vitehub agent dev "List the objects under reports/" --agent support`. Confirm that the output shows a `[tool] blob_read` call with `operation: "list"`.
4. For Provider artifacts, run the Agent so that it writes a file under an `assetPaths` root and links it in the final answer. Confirm that the final text contains the published URL.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Adds `blob_edit` when set to `"write"`. Other values fail when the Agent Definition loads. |
| `assetPaths` | `boolean \| string \| string[]` | `false` | Write mode and Provider-backed Drivers only. Materializes these Workspace paths and publishes current-run files that the final Markdown references. `true` uses `screenshots`. |
| `store` | `string` | default store | Selects a named Blob Store through `store()` on the Blob handle. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for `blob_edit`. Has no effect on artifact publication. |

## Related pages

- [Blob primitive](/docs/blob)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
