---
title: Content capability
description: Let an Agent read, draft, publish, and schedule documents in Content collections, with access checked by your authorize policy.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-file-pen-line
---

`content()` gives an Agent tools to list, read, draft, publish, and schedule documents in the [collections and singletons](/docs/content/configure#document-collections) of `server/content.ts`. Tool inputs follow each collection's fields, so the model sees typed data. Every tool calls `content.can()` with the Invocation's [Actor](/docs/agents/actors) and the Auth user it stands for, so `defineContent({ authorize })` decides what the Agent may do, document by document. Publishing and scheduling ask for approval by default and publish exactly the drafts the approver saw.

The [Content server API](/docs/content/server-api) covers application code. This page covers the Agent tools.

## Add the Capability

Define collections and an `authorize` policy in `server/content.ts`:

```ts [server/content.ts]
import { defineContent, documents, singleton } from 'vite-hub/content'
import { z } from 'zod'

export const content = defineContent({
  workspace: 'site',
  collections: {
    posts: documents({
      path: 'posts/**/*.md',
      fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
    settings: singleton({ path: 'settings.json', fields: { title: z.string() } }),
  },
  authorize: ({ user, action }) => user?.role === 'editor' || (action === 'read' && Boolean(user)),
})
```

Then add `content()` to the Agent:

```ts [server/agents/editor.ts]
import { defineAgent } from 'vite-hub/agent'
import { content } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [content({ collections: ['posts', 'settings'] })],
})
```

ViteHub passes the `content` export of `server/content.ts` to the Capability as the `content` primitive. Generated Agent routes and Schedules import it when the file exists. With Auth configured, they also pass the `auth` primitive (`agentAuth` from `vite-hub/auth/agent`), which reads the Auth user behind an Actor. A custom route that calls `runAgent()` passes both in the runtime context as `capabilities: { content, auth: agentAuth }`.

## Tools

| Tool | Operation | Access check | Default policy | Effect |
| --- | --- | --- | --- | --- |
| `content_list_collections` | `read` | none | `allow` | Lists collections and singletons with `kind`, `label`, `titleField`, `format`, `fields`, `path`, the singleton `id`, and which of `read`, `write`, and `publish` the user may do in each. |
| `content_list_documents` | `read` | `read`, then `read` for each document | `allow` | Lists documents without bodies. Supports `ref`, `filter`, `search`, `sort`, `limit` (default 20, at most 100), and `cursor`. |
| `content_get_document` | `read` | `read` for the document | `allow` | Returns one document with `data`, `body`, `digest`, `updatedAt`, and the field `issues` of a draft. |
| `content_status` | `read` | `read`, then `read` for each document | `allow` | Compares draft and published documents: `draft`, `published`, `changed`, or `deleted`, with each draft digest, the `issues` count, and the `schedule`. |
| `content_list_schedules` | `read` | `read` for each document of a schedule | `allow` | Lists pending, overdue, and failed schedules. Filter by `collection`, `id`, and `status`. |
| `content_save_draft` | `write` | `write` for the document | `allow` | Saves one document to the `draft` ref. |
| `content_publish` | `publish` | `publish` for each document | `require-approval` | Copies the listed drafts to the `published` ref, pinned to their digests. |
| `content_schedule` | `publish` | `publish` for each document | `require-approval` | Publishes the listed drafts at `at`, pinned to their digests. |
| `content_unschedule` | `publish` | `publish` for each document of the schedule | `require-approval` | Cancels a pending schedule, or dismisses a failed one. |

`content_save_draft` requires the full field values in `data` and `ifDigest`. Set `ifDigest` to the `digest` from `content_get_document` with `ref: 'draft'`, or `null` for a new document. The tool never overwrites a draft that changed since the Agent read it. A Markdown collection also requires the full `body`. A JSON or YAML collection has no body: omit `body` or send an empty string.

A singleton has one document, so its tools take no `id`. The singleton's own `id` also works. Any other `id` returns `CONTENT_INVALID`. A collection always needs `id`.

`content_publish` takes `documents: [{ collection, id, digest }]`, with each `digest` the `draft` digest from `content_status`, or `null` to publish a deletion. Omit `id` for a singleton. These digests are part of the call, so the approver sees exactly which versions will go live. The tool publishes with [`content.publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed): if any listed draft changed after the call was made, nothing is published.

`content_schedule` takes `{ at, documents, message? }`. `at` is an ISO timestamp with a time zone, such as `2026-10-20T09:00:00+02:00`, in the future. `documents` has the same form as for `content_publish`. The digests must match when the tool runs, and a [runner](/docs/content/scheduling#run-due-schedules) publishes exactly those versions at `at`. A draft saved after scheduling makes the run publish nothing, and the schedule becomes `failed`. `content_unschedule` takes `{ schedule }`, the schedule `id` from `content_list_schedules` or `content_status`.

The following Agent-visible definitions are resolved from the real Capability during the docs build, for one `posts` collection.

::agent-capability-tools{name="content" variant="default"}
::

With more than one collection, `data` lists each collection's fields as an alternative whose `title` is the collection name. The runtime validates `data` against the collection named in `collection`. The top level of each input schema stays a plain object, because some model providers reject a top-level `anyOf`. When a singleton is in scope, `id` is optional in the schema. When a JSON or YAML collection is in scope, `body` is optional. The tools then check both for the named collection.

## Field issues

Drafts accept fields that do not validate yet, so the Agent can save work in progress. `content_save_draft` then returns `ok: true` with the saved `document`, the `issues`, and a `hint` that the draft cannot be published until the issues are fixed. `content_status` counts them as `issues`. `content_publish` and `content_schedule` refuse such a draft with `CONTENT_INVALID`, and change nothing.

```json
{
  "ok": true,
  "document": { "collection": "posts", "id": "hello", "digest": "4f1c…" },
  "issues": [{ "field": "title", "path": [], "message": "Too small: expected string to have >=1 characters" }],
  "hint": "The draft is saved, but it cannot be published or scheduled until these issues are fixed. Save again with valid fields and ifDigest set to document.digest."
}
```

## Results the Agent can act on

Digest conflicts, invalid drafts, held leases, and missing documents come back as tool results with `ok: false` and a `hint`, so the model can fix the input and call again:

| `error.code` | Tools | What the result carries |
| --- | --- | --- |
| `CONTENT_INVALID` | `content_save_draft`, `content_get_document`, and any tool for an invalid input | `issues`: one `{ field?, path, message }` per problem, such as data that cannot be stored or a `body` for a JSON collection. From `content_get_document`, a published file that no longer validates also returns its stored `text` and `digest`, so the Agent can save a repaired version over it. |
| `CONTENT_INVALID` | `content_publish`, `content_schedule` | `documents`: one `{ collection, id, path, issues }` per draft with field issues. Nothing was changed. |
| `WORKSPACE_CONFLICT` | `content_save_draft` | `currentDigest`: the draft's digest now. Read the draft again, apply the change to that version, and save with its digest. |
| `WORKSPACE_CONFLICT` | `content_publish`, `content_schedule` | `documents`: one `{ collection, id, expected, actual }` per draft that changed after the call. Nothing was changed. Review the changes and make the call again with the `actual` digests. |
| `CONTENT_LEASE_HELD` | `content_save_draft` | `holder`: `{ name, kind, since, expiresAt }` of the person or live room that edits the document. Nothing was saved. Wait for the lease to end, or ask the person. |
| `CONTENT_R0011` | `content_schedule` | The schedule options are not valid: `at` is in the past, the drafts are already published, or a document is in another schedule. |
| `CONTENT_NOT_FOUND` | `content_get_document`, `content_unschedule` | The document does not exist on that ref, or the schedule already ran or was cancelled. |
| `CONTENT_R0009` | `content_publish`, `content_schedule` | The same document is listed twice. |

```json
{
  "ok": false,
  "error": {
    "code": "CONTENT_LEASE_HELD",
    "holder": { "name": "Ana", "kind": "edit", "since": "2026-10-15T09:00:00.000Z", "expiresAt": "2026-10-15T09:05:00.000Z" },
    "hint": "A person is editing this document now. Do not save over their work: wait until the lease expires and try again, or ask them to finish or close the document.",
    "message": "Ana is editing Content document \"posts/hello\". Wait for the lease to end, or pass lease: 'override' to write anyway."
  }
}
```

A successful save returns `{ ok: true, document }` without the body. A publish returns `{ ok: true, revision, documents }`, where `revision` is null when nothing differed. A schedule returns `{ ok: true, schedule: { id, at, status, documents, createdAt, message? } }`. Other errors, such as an unknown collection, fail the tool call.

## Edit leases

A person who has a document open in the [Console](/docs/content/console) holds its [edit lease](/docs/content/editing-together#writes-and-leases). `content_save_draft` honors the lease: it returns `CONTENT_LEASE_HELD` and saves nothing. The model cannot override the lease from the tool input.

To let the Agent save over a held lease, opt in on the Capability. The person's next save then fails with `WORKSPACE_CONFLICT`, because the Console saves with `ifDigest`:

```ts [server/agents/editor.ts]
content({ lease: 'override' })
```

`content_publish` and `content_schedule` do not check leases. They publish the reviewed digests, and a save after review already fails them with `WORKSPACE_CONFLICT`.

## Access and approval

Each check calls `content.can({ user, actor, collection, action, id })`. `actor` is the Invocation's Actor. `user` is the Auth user that Actor stands for: [`authenticated()`](/docs/agents/actors) from `vite-hub/auth/agent` records the user id as `actor.meta.authUserId`, and the Capability reads that user from the Auth database through the `auth` primitive. It reads the user again when an approved call runs, so a role removed in the meantime takes effect. An anonymous Actor, an Actor without `authUserId`, an app without Auth, or a deleted user gives `user: null`. One `authorize` policy then covers the Console and the Agent, and it can check `actor` to give the Agent less than the user it acts for.

Reads check `read` on both refs, also for published documents. Like the Console, the tools check `read` for each document: lists, search results, totals, statuses, and schedules never show a document that `authorize` hides, and `content_get_document` denies it. A schedule shows only when the user may read every document in it. To let an Agent read what the site serves, return `true` for `read` in `authorize`.

Without `authorize`, `content.can()` returns `false`, so the Agent can do nothing. A denied call fails with `CAPABILITY_DENIED` and runs nothing.

When your users live outside ViteHub Auth, map the Actor yourself with `user`. It replaces the Auth lookup:

```ts [server/agents/editor.ts]
content({
  user: async actor => actor.kind === 'authUser' ? await findMember(actor.id) : null,
})
```

A `chat.message` Trigger without `invoker` derives a `chat` Actor from the platform user. `authorize` receives it with `kind: 'chat'`. Do not grant `write` or `publish` from chat identity alone.

`content_publish`, `content_schedule`, and `content_unschedule` use `policy: 'require-approval'`. The call stops with `APPROVAL_REQUIRED` and an Approval Request that shows the input, such as the listed documents and digests, and runs only after approval. `content_save_draft` runs without approval, because drafts are not served. Set `policy` to replace all four defaults. A function receives `{ name, input }`:

```ts
content({
  policy: ({ name }) => name === 'content_save_draft' ? 'allow' : 'require-approval',
})
```

The tools check `content.can()` before the policy, so a denied call fails at once instead of waiting for an approver. They check again when the approved call runs. Approval cannot grant an action that `authorize` denies.

Saves, publishes, schedules, and cancellations record `metadata.agent = { name, actor }`, so [`content.revisions()`](/docs/content/server-api#revisions) and [`content.schedules()`](/docs/content/scheduling#inspect-and-cancel) show which Agent and Actor made each change.

## Verify the tools

1. Run `vitehub agent info --agent editor --json`. Confirm `tools` has an entry named `content` with the expected commands and `capabilities` has `{ id: "content" }`.
2. Ask the Agent to draft a post. Confirm `content_save_draft` returns `ok: true` and `content.collection('posts').status('<id>')` reports `draft`.
3. Ask it to publish. Approve the request, then read the post from `/api/content/posts/<id>`.
4. Ask it to schedule a change for tomorrow. Approve the request, then confirm `content.schedules()` lists it.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `collections` | `string[]` | every collection | Collections and singletons the Agent may use. An unknown name fails when the tools resolve. |
| `operations` | `Array<"read" \| "write" \| "publish">` | `["read", "write", "publish"]` | Tool groups to expose. Without `read`, the Agent can only create new documents, because saving over a draft needs its digest. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | save `allow`, publish, schedule, and unschedule `require-approval` | Replaces the policy of `content_save_draft`, `content_publish`, `content_schedule`, and `content_unschedule`. |
| `user` | `(actor) => user \| null \| Promise<user \| null>` | the Auth user from `actor.meta.authUserId`, or `null` | Maps the Actor to the `user` that `authorize` receives, instead of the Auth lookup. |
| `lease` | `"override"` | honor leases | Lets `content_save_draft` save while a person holds the edit lease. |

The Capability reports `mode: 'write'` when `write` or `publish` is enabled. Its metadata lists `collections`, `operations`, `approval`, and `lease` when set.

## Limits

- The Capability does not remove or restore documents. Call `remove()` and `restore()` from application code or a [Custom Capability](/docs/agents/capabilities/custom).
- Approval covers the listed digests. A save between the call and its execution fails the publish or schedule with `WORKSPACE_CONFLICT` instead of publishing unreviewed content, and the Agent has to request a new approval.
- A scheduled publish needs a runner that calls `content.publishDue()`. See [Scheduling](/docs/content/scheduling#run-due-schedules).
- The per-document `read` check calls `authorize` once for each document of the collection on each list and status call.
- Resolving the Auth user reads the Auth database once per Invocation.
- Document bodies are untrusted data. The tool descriptions tell the model so, but an `authorize` policy is the actual boundary.
- Content collections need a Workspace with retained history, which needs a Database. The Capability is not available in standalone Agent builds without a host runtime.

## Related pages

- [Content configuration](/docs/content/configure)
- [Content server API](/docs/content/server-api)
- [Scheduling](/docs/content/scheduling)
- [Editing together](/docs/content/editing-together)
- [Agent Actors](/docs/agents/actors)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
