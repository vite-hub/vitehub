---
title: Content capability
description: Let an Agent read, draft, and publish documents in Content collections, with access checked by your authorize policy.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-file-pen-line
---

`content()` gives an Agent tools to list, read, draft, and publish documents in the [collections](/docs/content/configure#document-collections) of `server/content.ts`. Tool inputs follow each collection's fields, so the model sees typed frontmatter. Every non-public action calls `content.can()` with the Invocation's [Actor](/docs/agents/actors) and the Auth user it stands for, so `defineContent({ authorize })` decides what the Agent may do. Publishing asks for approval by default and publishes exactly the drafts the approver saw.

The [Content server API](/docs/content/server-api) covers application code. This page covers the Agent tools.

## Add the Capability

Define collections and an `authorize` policy in `server/content.ts`:

```ts [server/content.ts]
import { defineContent, documents } from 'vite-hub/content'
import { z } from 'zod'

export const content = defineContent({
  workspace: 'site',
  collections: {
    posts: documents({
      path: 'posts/**/*.md',
      fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
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
  capabilities: [content({ collections: ['posts'] })],
})
```

ViteHub passes the `content` export of `server/content.ts` to the Capability as the `content` primitive. Generated Agent routes and Schedules import it when the file exists. With Auth configured, they also pass the `auth` primitive (`agentAuth` from `vite-hub/auth/agent`), which reads the Auth user behind an Actor. A custom route that calls `runAgent()` passes both in the runtime context as `capabilities: { content, auth: agentAuth }`.

## Tools

| Tool | Operation | Access check | Effect |
| --- | --- | --- | --- |
| `content_list_collections` | `read` | none | Lists collections, their fields, and which of `read`, `write`, and `publish` the user may do in each. |
| `content_list_documents` | `read` | `read` for `ref: 'draft'` | Lists documents without bodies. Supports `filter`, `search`, `sort`, `limit` (default 20, at most 100), and `cursor`. |
| `content_get_document` | `read` | `read` for `ref: 'draft'` | Returns one document with `data`, `body`, `digest`, and `updatedAt`. |
| `content_status` | `read` | `read` | Compares draft and published documents: `draft`, `published`, `changed`, or `deleted`, with each draft digest. |
| `content_save_draft` | `write` | `write` | Validates and saves one document to the `draft` ref. |
| `content_publish` | `publish` | `publish` for each document | Copies the listed drafts to the `published` ref, pinned to their digests. |

Reads default to the `published` ref, which [`/api/content/**`](/docs/content/configure#access) already serves publicly, so they need no access check. Everything else does.

`content_save_draft` requires the full frontmatter in `data`, the full Markdown `body`, and `ifDigest`. Set `ifDigest` to the `digest` from `content_get_document` with `ref: 'draft'`, or `null` for a new document. The tool never overwrites a draft that changed since the Agent read it.

`content_publish` takes `documents: [{ collection, id, digest }]`, with each `digest` the `draft` digest from `content_status`, or `null` to publish a deletion. These digests are part of the call, so the approver sees exactly which versions will go live. The tool publishes with [`content.publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed): if any listed draft changed after the call was made, nothing is published.

The following Agent-visible definitions are resolved from the real Capability during the docs build, for one `posts` collection.

::agent-capability-tools{name="content" variant="default"}
::

With more than one collection, `data` lists each collection's fields as an alternative whose `title` is the collection name. The runtime validates `data` against the collection named in `collection`.

## Results the Agent can act on

Validation failures, digest conflicts, and missing documents come back as tool results with `ok: false`, so the model can fix the input and call again:

| `error.code` | Tools | What the result carries |
| --- | --- | --- |
| `CONTENT_INVALID` | `content_save_draft`, `content_get_document`, `content_publish` | `issues`: one `{ field, path, message }` per invalid field. From `content_get_document`, also the stored file as `text` and its `digest`, so the Agent can save a repaired version over it. From `content_publish`, nothing was published. |
| `WORKSPACE_CONFLICT` | `content_save_draft` | `currentDigest`: the draft's digest now. Read the draft again, apply the change to that version, and save with its digest. |
| `WORKSPACE_CONFLICT` | `content_publish` | `documents`: one `{ collection, id, expected, actual }` per draft that changed after the call. Nothing was published. Review the changes and request the publish again with the `actual` digests. |
| `CONTENT_NOT_FOUND` | `content_get_document` | The document does not exist on that ref. |
| `CONTENT_R0009` | `content_publish` | The same document is listed twice. |

```json
{
  "ok": false,
  "error": {
    "code": "WORKSPACE_CONFLICT",
    "currentDigest": "4f1c…",
    "hint": "The draft changed since you read it. Read it again with content_get_document (ref: draft), apply your change to that version, and save with its digest.",
    "message": "[vitehub] Content document \"posts/hello\" changed on the draft."
  }
}
```

A successful save returns `{ ok: true, document }` without the body. A publish returns `{ ok: true, revision, documents }`, where `revision` is null when nothing differed. Other errors, such as an invalid id, fail the tool call.

## Access and approval

Each check calls `content.can({ user, actor, collection, action, id })`. `actor` is the Invocation's Actor. `user` is the Auth user that Actor stands for: [`authenticated()`](/docs/agents/actors) from `vite-hub/auth/agent` records the user id as `actor.meta.authUserId`, and the Capability reads that user from the Auth database through the `auth` primitive. It reads the user again when an approved call runs, so a role removed in the meantime takes effect. An anonymous Actor, an Actor without `authUserId`, an app without Auth, or a deleted user gives `user: null`. One `authorize` policy then covers the Console and the Agent, and it can check `actor` to give the Agent less than the user it acts for.

Without `authorize`, `content.can()` returns `false`, so the Agent can only read published documents. A denied call fails with `CAPABILITY_DENIED` and runs nothing.

When your users live outside ViteHub Auth, map the Actor yourself with `user`. It replaces the Auth lookup:

```ts [server/agents/editor.ts]
content({
  user: async actor => actor.kind === 'authUser' ? await findMember(actor.id) : null,
})
```

A `chat.message` Trigger without `invoker` derives a `chat` Actor from the platform user. `authorize` receives it with `kind: 'chat'`. Do not grant `write` or `publish` from chat identity alone.

`content_publish` uses `policy: 'require-approval'`. The call stops with `APPROVAL_REQUIRED` and an Approval Request that shows the listed documents and digests, and publishes only after approval. `content_save_draft` runs without approval, because drafts are not served. Set `policy` to replace both defaults. A function receives `{ name, input }`:

```ts
content({
  policy: ({ name }) => name === 'content_publish' ? 'require-approval' : 'allow',
})
```

The tools check `content.can()` before the policy, so a denied publish fails at once instead of waiting for an approver. They check again when the approved call runs. Approval cannot grant an action that `authorize` denies.

Saves and publishes record `metadata.agent = { name, actor }` on the revision, so [`content.revisions()`](/docs/content/server-api#revisions) shows which Agent and Actor made each change.

## Verify the tools

1. Run `vitehub agent info --agent editor --json`. Confirm `tools` has an entry named `content` with the expected commands and `capabilities` has `{ id: "content" }`.
2. Ask the Agent to draft a post. Confirm `content_save_draft` returns `ok: true` and `content.collection('posts').status('<id>')` reports `draft`.
3. Ask it to publish. Approve the request, then read the post from `/api/content/posts/<id>`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `collections` | `string[]` | every collection | Collections the Agent may use. An unknown name fails when the tools resolve. |
| `operations` | `Array<"read" \| "write" \| "publish">` | `["read", "write", "publish"]` | Tool groups to expose. Without `read`, the Agent can only create new documents, because saving over a draft needs its digest. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | save `allow`, publish `require-approval` | Replaces the policy of `content_save_draft` and `content_publish`. |
| `user` | `(actor) => user \| null \| Promise<user \| null>` | the Auth user from `actor.meta.authUserId`, or `null` | Maps the Actor to the `user` that `authorize` receives, instead of the Auth lookup. |

The Capability reports `mode: 'write'` when `write` or `publish` is enabled. Its metadata lists `collections`, `operations`, and `approval`.

## Limits

- The Capability does not remove or restore documents. Call `remove()` and `restore()` from application code or a [Custom Capability](/docs/agents/capabilities/custom).
- Approval covers the listed digests. A save between the call and its execution fails the publish with `WORKSPACE_CONFLICT` instead of publishing unreviewed content, and the Agent has to request a new approval.
- Resolving the Auth user reads the Auth database once per Invocation.
- Document bodies are untrusted data. The tool descriptions tell the model so, but an `authorize` policy is the actual boundary.
- Content collections need a Workspace with retained history, which needs a Database. The Capability is not available in standalone Agent builds without a host runtime.

## Related pages

- [Content configuration](/docs/content/configure)
- [Content server API](/docs/content/server-api)
- [Agent Actors](/docs/agents/actors)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
