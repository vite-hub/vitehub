---
title: Content capability
description: Let an Agent read, draft, and publish documents in Content collections, with access checked by your authorize policy.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-file-pen-line
---

`content()` gives an Agent tools to list, read, draft, and publish documents in the [collections](/docs/content/configure#document-collections) of `server/content.ts`. Tool inputs follow each collection's fields, so the model sees typed frontmatter. Every non-public action calls `content.can()` with the Invocation's [Actor](/docs/agents/actors), so `defineContent({ authorize })` decides what the Agent may do. Publishing asks for approval by default.

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
  authorize: ({ user, action }) => user?.meta?.role === 'editor' || (action === 'read' && Boolean(user)),
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

ViteHub passes the `content` export of `server/content.ts` to the Capability as the `content` primitive. Generated Agent routes and Schedules import it when the file exists. A custom route that calls `runAgent()` passes it in the runtime context as `capabilities: { content }`.

## Tools

| Tool | Operation | Access check | Effect |
| --- | --- | --- | --- |
| `content_list_collections` | `read` | none | Lists collections, their fields, and which of `read`, `write`, and `publish` the user may do in each. |
| `content_list_documents` | `read` | `read` for `ref: 'draft'` | Lists documents without bodies. Supports `filter`, `search`, `sort`, `limit` (default 20, at most 100), and `cursor`. |
| `content_get_document` | `read` | `read` for `ref: 'draft'` | Returns one document with `data`, `body`, and `digest`. |
| `content_status` | `read` | `read` | Compares draft and published documents: `draft`, `published`, `changed`, or `deleted`. |
| `content_save_draft` | `write` | `write` | Validates and saves one document to the `draft` ref. |
| `content_publish` | `publish` | `publish` | Copies draft changes to the `published` ref, for a whole collection or selected `ids`. |

Reads default to the `published` ref, which [`/api/content/**`](/docs/content/configure#access) already serves publicly, so they need no access check. Everything else does.

`content_save_draft` requires the full frontmatter in `data`, the full Markdown `body`, and `ifDigest`. Set `ifDigest` to the `digest` from `content_get_document` with `ref: 'draft'`, or `null` for a new document. The tool never overwrites a draft that changed since the Agent read it.

The following Agent-visible definitions are resolved from the real Capability during the docs build, for one `posts` collection.

::agent-capability-tools{name="content" variant="default"}
::

With more than one collection, `data` lists each collection's fields as an alternative whose `title` is the collection name. The runtime validates `data` against the collection named in `collection`.

## Results the Agent can act on

Validation failures, digest conflicts, and missing documents come back as tool results with `ok: false`, so the model can fix the input and call again:

| `error.code` | Tools | What the result carries |
| --- | --- | --- |
| `CONTENT_INVALID` | `content_save_draft`, `content_get_document` | `issues`: one `{ field, path, message }` per invalid field. |
| `WORKSPACE_CONFLICT` | `content_save_draft` | `currentDigest`: the draft's digest now. Read the draft again, apply the change to that version, and save with its digest. |
| `WORKSPACE_CONFLICT` | `content_publish` | `currentHead`: the `published` revision now. Check `content_status` and publish again with `ifHead: currentHead`. |
| `CONTENT_NOT_FOUND` | `content_get_document`, `content_publish` | The document does not exist on that ref. |

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

Each check calls `content.can({ user, collection, action, id })`. The `user` is the Invocation's Actor, `{ id, kind, label, email, meta }`. An anonymous Actor becomes `user: null`. Without `authorize`, `content.can()` returns `false`, so the Agent can only read published documents. A denied call fails with `CAPABILITY_DENIED` and runs nothing.

Pass trusted roles through the Actor. With [`authenticated()`](/docs/agents/actors) from `vite-hub/auth/agent`, put them in `meta`. When `authorize` expects your application's user record instead, map the Actor with `user`:

```ts [server/agents/editor.ts]
content({
  user: async actor => actor.kind === 'authUser' ? await findUser(actor.meta?.authUserId) : null,
})
```

A `chat.message` Trigger without `invoker` derives a `chat` Actor from the platform user. `authorize` receives it with `kind: 'chat'`. Do not grant `write` or `publish` from chat identity alone.

`content_publish` uses `policy: 'require-approval'`. The call stops with `APPROVAL_REQUIRED` and an Approval Request, and publishes only after approval. `content_save_draft` runs without approval, because drafts are not served. Set `policy` to replace both defaults. A function receives `{ name, input }`:

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
| `user` | `(actor) => user \| null \| Promise<user \| null>` | the Actor, or `null` when anonymous | Maps the Actor to the `user` that `authorize` receives. |

The Capability reports `mode: 'write'` when `write` or `publish` is enabled. Its metadata lists `collections`, `operations`, and `approval`.

## Limits

- The Capability does not remove or restore documents. Call `remove()` and `restore()` from application code or a [Custom Capability](/docs/agents/capabilities/custom).
- Approval covers the publish call, not the draft content at that moment. A save that lands between approval and execution is published too. Pass `ids` to limit what one approval publishes.
- Document bodies are untrusted data. The tool descriptions tell the model so, but an `authorize` policy is the actual boundary.
- Content collections need a Workspace with retained history, which needs a Database. The Capability is not available in standalone Agent builds without a host runtime.

## Related pages

- [Content configuration](/docs/content/configure)
- [Content server API](/docs/content/server-api)
- [Agent Actors](/docs/agents/actors)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
