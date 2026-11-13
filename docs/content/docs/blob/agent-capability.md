---
title: Blob capability
description: Give an Agent a Blob read tool and, in write mode, a tool that puts or deletes files.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-file-box
---

A Capability is a set of tools that you give an Agent. `blob()` gives the `blob_read` tool to get, head, and list files. In write mode, it adds `blob_edit` to put and delete files.
Both tools call your [Blob](/docs/blob) setup. For Provider-backed Agents, `assetPaths` also publishes files that the final answer links.
For app code, read the [Blob server API](/docs/blob/server-api).

## Configure Blob access

Use read mode until the Agent must write files.

```ts [server/agents/support.ts] fragment
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

The docs build reads these definitions from the real Capability.

### Read mode

::agent-capability-tools{name="blob" variant="read"}
::

### Write mode

::agent-capability-tools{name="blob" variant="write"}
::

## How Blob access works

The Capability finds the store when the Agent calls a tool, not when tools are listed. With `store`, it calls `store(name)` on the Blob handle.

Each `blob_read` call runs one operation:

- `get` returns the file at `pathname`.
- `head` returns its metadata.
- `list` requires a non-empty `prefix`, except with the `prefix` option. It passes `cursor`, `folded`, and `limit` to the Blob handle. `limit` defaults to 25, with a maximum of 100.

Each `blob_edit` call runs one operation:

- `put` writes to `pathname` from exactly one source: inline `body`, an attachment of the current input (`attachmentId`), or a Workspace file (`workspacePath`). `options` passes write options, such as `contentType`. For an attachment, its media type replaces `options.contentType`.
- `delete` removes the file at `pathname` and returns `{ pathname, deleted: true }`.

When the current input has attachments, the `blob_edit` description lists their IDs and media types.

## Limit the Agent to a folder

`prefix` keeps both tools inside one folder of the store.

```ts [server/agents/support.ts] fragment
blob({ mode: 'write', prefix: 'reports/' })
```

The Capability decodes each pathname once and removes leading slashes, as the Blob primitive does. Then it checks that the pathname starts with `reports/`.

- `reports/a.txt` and `/reports/a.txt` are inside. `reports`, `reports-private/a.txt`, `reports/../secret.txt`, and `reports%2F..%2Fsecret.txt` are not.
- For `put`, the check covers `options.prefix` joined before `pathname`, because the Blob primitive writes to that joined pathname.
- `list` without `prefix`, or with `reports`, lists `reports/`. A list prefix outside the folder fails. The result keeps only objects and folders inside it.
- A pathname outside the folder fails with `AGENT_R1045` and the store is not called.

## Provider artifacts

List the folders where a Provider-backed Agent may write public artifacts. The Agent writes files as usual, then links one in its final answer.

```ts [server/agents/review.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { blob } from 'vite-hub/agent/capabilities'
import { github } from 'vite-hub/agent/channels'

export default defineAgent({
  capabilities: [
    blob({ assetPaths: ['artifacts'], mode: 'write', policy: 'deny' }),
  ],
  channels: {
    github: github({ pullRequest: true }),
  },
  driver: codexDriver(),
  workspace: { commit: true, mode: 'write' },
})
```

If Codex adds `![Preview](artifacts/preview.png)` to its answer, ViteHub publishes the file under `vitehub-agent-artifacts/`, records it in `AgentRunResult.artifacts`, and rewrites that link.

Limits:

- `assetPaths` works only in write mode with Provider-backed Drivers. Read mode ignores it.
- Each path is relative to the Workspace, with no `.` or `..` segments. `assetPaths: true` uses `screenshots`.
- Only Markdown links or images under `assetPaths` count, and only for files that this run added or changed in the Workspace. Bare paths, old files, removed files, and paths outside the roots are ignored.
- `policy` controls only the `blob_edit` tool, which publishing does not use. The example sets `policy: 'deny'`, so the Agent cannot call `blob_edit`, but artifacts are still published.

Turn on Blob serving or use a driver that returns public URLs. Publishing fails when `put()` returns no `url`. A route-relative URL from `blob.serve` is resolved against the URL of the request that started the Agent.

## Workspace uploads

Use `workspacePath` to upload a Workspace file, such as a screenshot from another Capability. The path is relative to the Workspace. The Capability reads the active Workspace Session first, then the file system.

```ts [Agent tool call] fragment
await blob_edit({
  operation: 'put',
  pathname: 'review/screenshots/home.png',
  workspacePath: 'screenshots/home.png',
  options: { contentType: 'image/png' },
})
```

## Requirements

- Configure Blob. Generated Agent routes then pass `blob` from `vite-hub/blob` to the Capability.
- Without a `blob` handle, the Capability imports `@vite-hub/blob`. If that fails, the first tool call fails, though the tools are still listed.
- `store` requires a Blob handle that exposes `store()`.
- `workspacePath` requires a Workspace file system or an active Agent Workspace Session.

## Security and approval

- Without `prefix`, read mode lets the Agent read any pathname, and list under any non-empty prefix, in the selected store. Write mode lets it put or delete any pathname, including input attachments and Workspace files.
- With `prefix`, both tools stay inside that folder. The tool descriptions tell the Agent the folder. Provider artifacts that `assetPaths` publishes are not tool calls, and they still go under `vitehub-agent-artifacts/`.
- To keep the Agent away from other data completely, give it its own store with `store`.
- `policy` applies only to `blob_edit`. `blob_read` has no policy gate.
- `policy` accepts `'allow'`, `'require-approval'`, `'deny'`, `'retryable-failure'`, or a function that gets `{ name, input }` and returns one of them.
- Without `policy`, `blob_edit` runs when the Agent calls it.
- `'require-approval'` stops the call with `APPROVAL_REQUIRED` and an Approval Request. The write runs after approval. See [Runtime policy, approvals, and traces](/docs/agents/runtime-policy).
- Published artifacts get public URLs. List only `assetPaths` whose files may be public.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets `blob_read` and, in write mode, `blob_edit`. `assetPaths` does nothing. |
| Provider-backed | Gets the same tools through the provider MCP bridge. In write mode, `assetPaths` also publishes files from this run that the final Markdown links. |
| Custom-run-backed | `driver.run` gets the tools in `context.tools` and decides whether to call them. `assetPaths` does nothing. |

## Verify Blob access

1. Start the dev server.
2. Run `vitehub agent info --agent support --json`. Check that `tools` has an entry with `name: "blob"`. It lists one entry per Capability, not per tool.
3. Run `vitehub agent dev "List the objects under reports/" --agent support`. Check for a `[tool] blob_read` call with `operation: "list"`.
4. For Provider artifacts, make the Agent write a file under an `assetPaths` root and link it in its answer. Check that the final text has the published URL.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | `"write"` adds `blob_edit`. Other values fail when the Agent loads. |
| `assetPaths` | `boolean \| string \| string[]` | `false` | Write mode and Provider-backed Drivers only. Copies out these Workspace paths and publishes files from this run that the final Markdown links. `true` uses `screenshots`. |
| `store` | `string` | default store | Named store, through `store()` on the Blob handle. |
| `prefix` | `string` | none (whole store) | Limits `blob_read` and `blob_edit` to pathnames under this folder, such as `reports/`. An empty prefix, or one with `.` or `..` segments, `\`, or percent-encoding, fails with `AGENT_R1044` when the Agent loads. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | none (calls run) | Policy for `blob_edit`. Does not affect artifact publishing. |

## Related pages

- [Blob primitive](/docs/blob)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
