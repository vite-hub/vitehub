---
title: Content capability
description: Let an Agent read, draft, publish, and schedule documents in Content collections, with access checked by your authorize policy.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-file-pen-line
---

`content()` gives an Agent tools to list, read, draft, publish, and schedule documents in the [collections and singletons](/docs/content/configure#document-collections) of `server/content.ts`. Tool inputs follow each collection's fields, so the model sees typed data. Every tool calls `content.can()` with the Invocation's [Invoker](/docs/agents/trusted-invokers) and the Auth user it stands for, so `defineContent({ authorize })` decides what the Agent may do, document by document. Publishing and scheduling ask for approval by default and publish exactly the drafts the approver saw.

For application code, see the [Content server API](/docs/content/server-api).

## Add the Capability

Define collections and an `authorize` policy in `server/content.ts`:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents, singleton } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
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

```ts [server/agents/editor.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { content } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [content({ collections: ['posts', 'settings'] })],
})
```

Generated Agent routes and Schedules pass the default export of `server/content.ts` to the Capability. With Auth, they also pass `agentAuth` from `vite-hub/auth/agent`, which reads the Auth user behind an Invoker. A custom route that calls `runAgent()` passes both as `capabilities: { content, auth: agentAuth }`.

## Tools

| Tool | Operation | Access check | Default policy | Effect |
| --- | --- | --- | --- | --- |
| `content_list_collections` | `read` | none | `allow` | Lists collections and singletons with `kind`, `label`, `titleField`, `format`, `fields`, `path`, the singleton `id`, and which of `read`, `write`, and `publish` the user may do. |
| `content_list_documents` | `read` | `read`, then `read` for each document | `allow` | Lists documents without bodies. Takes `ref`, `filter`, `search`, `sort`, `limit` (default 20, max 100), and `cursor`. |
| `content_get_document` | `read` | `read` for the document | `allow` | Returns one document with `data`, `body`, `digest`, `updatedAt`, and the field `issues` of a draft. |
| `content_status` | `read` | `read`, then `read` for each document | `allow` | Compares draft and published: `draft`, `published`, `changed`, or `deleted`, with each draft digest, `issues` count, and `schedule`. |
| `content_list_schedules` | `read` | `read` for each document of a schedule | `allow` | Lists pending, overdue, and failed schedules. Filter by `collection`, `id`, and `status`. |
| `content_list_translations` | `read` | `read`, then `read` for each document | `allow` | Lists the documents whose translation in a locale is `missing` or `stale`. Only when a collection in scope has [locales](/docs/content/configure#locales). |
| `content_save_draft` | `write` | `write` for the document | `allow` | Saves one document to the `draft` ref. |
| `content_publish` | `publish` | `publish` for each document | `require-approval` | Copies the listed drafts to the `published` ref, pinned to their digests. |
| `content_schedule` | `publish` | `publish` for each document | `require-approval` | Publishes the listed drafts at `at`, pinned to their digests. |
| `content_unschedule` | `publish` | `publish` for each document of the schedule | `require-approval` | Cancels a pending schedule, or dismisses a failed one. |

`content_save_draft` needs all field values in `data`, and `ifDigest`. Set `ifDigest` to the `digest` from `content_get_document` with `ref: 'draft'`, or `null` for a new document. The tool never overwrites a draft that changed since the Agent read it. A Markdown collection also needs the full `body`. JSON and YAML collections have no body: omit `body` or send an empty string.

For a singleton, omit `id` or pass its own `id`. Any other `id` returns `CONTENT_INVALID`. Collections need `id`.

`content_publish` takes `documents: [{ collection, id, digest }]`. Each `digest` is the `draft` digest from `content_status`, or `null` to publish a deletion. Omit `id` for a singleton. The digests are in the call, so the approver sees which versions go live. The tool uses [`content.publish({ expect })`](/docs/content/server-api#publish-what-was-reviewed): if a listed draft changed after the call, nothing is published.

`content_schedule` takes `{ at, documents, message? }`. `at` is a future ISO timestamp with a time zone, such as `2026-10-20T09:00:00+02:00`. `documents` is as for `content_publish`. The digests must match when the tool runs. A [runner](/docs/content/scheduling#run-due-schedules) publishes exactly those versions at `at`. If a draft is saved after scheduling, the run publishes nothing and the schedule turns `failed`. `content_unschedule` takes `{ schedule }`, the id from `content_list_schedules` or `content_status`.

These are the tool definitions the Agent sees for one `posts` collection, built from the real Capability.

::agent-capability-tools{name="content" variant="default"}
::

With several collections, `data` lists each one's fields as an alternative titled with its name, and the runtime validates against the named `collection`. Input schemas stay plain objects at the top level, because some model providers reject a top-level `anyOf`. A singleton in scope makes `id` optional, and a JSON or YAML collection makes `body` optional. The tools check both per collection.

## Translations

When a collection in scope has [locales](/docs/content/configure#locales), `content_list_documents`, `content_get_document`, `content_status`, `content_save_draft`, and the `documents` of `content_publish` take `locale`. `null` is the source locale. `content_schedule` supports only the source locale of each collection; its `documents` accept that locale or `null`. `content_list_collections` lists the `locales` of each collection, source locale first.

To translate, the Agent calls `content_list_translations` with `{ collection, locale }`, reads each source document with `content_get_document` and `ref: 'draft'`, and saves the translation with `content_save_draft`, the `locale`, and `sourceDigest`. `content_get_document` returns `source: { path, digest }` in a collection with locales, and `sourceDigest` is that `source.digest` of the read the Agent translated. Set `ifDigest` to `null` for a missing translation, or to the `digest` that `content_get_document` returns for the stale one with `locale` and `ref: 'draft'`. The save records that source version as `derivedFrom`, so the translation is `current` until the source changes again, and `stale` at once when the source changed while the Agent translated. A save with `sourceDigest: null` keeps the `derivedFrom` of an existing translation. Collections without locales keep the same input schemas as before.

To translate each page when its source changes, run the Agent from a Queue job that a Workspace hook starts. See [Translate Content with an Agent](/docs/content/translate-with-an-agent).

## Field issues

Drafts accept invalid fields, so the Agent can save unfinished work. `content_save_draft` returns `ok: true` with the `document`, the `issues`, and a `hint` that the draft cannot publish until they are fixed. `content_status` counts `issues`. `content_publish` and `content_schedule` refuse the draft with `CONTENT_INVALID` and change nothing.

```json
{
  "ok": true,
  "document": { "collection": "posts", "id": "hello", "digest": "4f1c…" },
  "issues": [{ "field": "title", "path": [], "message": "Too small: expected string to have >=1 characters" }],
  "hint": "The draft is saved, but it cannot be published or scheduled until these issues are fixed. Save again with valid fields and ifDigest set to document.digest."
}
```

## Results the Agent can act on

Digest conflicts, invalid drafts, held leases, and missing documents return `ok: false` and a `hint`, so the model can fix the input and retry:

| `error.code` | Tools | What the result carries |
| --- | --- | --- |
| `CONTENT_INVALID` | `content_save_draft`, `content_get_document`, and any tool for an invalid input | `issues`: one `{ field?, path, message }` per problem, such as data that cannot be stored or a `body` for a JSON collection. From `content_get_document`, an invalid published file also returns its `text` and `digest`, so the Agent can save a fixed version. |
| `CONTENT_INVALID` | `content_publish`, `content_schedule` | `documents`: one `{ collection, id, path, issues }` per draft with field issues. Nothing changed. |
| `WORKSPACE_CONFLICT` | `content_save_draft` | `currentDigest`: the draft's current digest. Read the draft again, apply the change, and save with its digest. |
| `WORKSPACE_CONFLICT` | `content_publish`, `content_schedule` | `documents`: one `{ collection, id, expected, actual }` per draft that changed after the call. Nothing changed. Review the changes and call again with the `actual` digests. |
| `CONTENT_LEASE_HELD` | `content_save_draft` | `holder`: `{ name, kind, since, expiresAt }` of the person or live room editing. Nothing was saved. Wait for the lease to end, or ask the person. |
| `CONTENT_R0011` | `content_schedule` | Bad schedule options: `at` is past, the drafts are already published, or a document is in another schedule. |
| `CONTENT_NOT_FOUND` | `content_get_document`, `content_unschedule` | The document is not on that ref, or the schedule ran or was cancelled. |
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

A save returns `{ ok: true, document }` without the body. A publish returns `{ ok: true, revision, documents }`, with `revision` null when nothing differed. A schedule returns `{ ok: true, schedule: { id, at, status, documents, createdAt, message? } }`. Other errors, such as an unknown collection, fail the tool call.

## Edit leases

A person with a document open in the [Console](/docs/content/console) holds its [edit lease](/docs/content/editing-together#writes-and-leases). `content_save_draft` then returns `CONTENT_LEASE_HELD` and saves nothing. The model cannot override the lease from tool input.

To let the Agent save over a held lease, opt in on the Capability. The person's next save then fails with `WORKSPACE_CONFLICT`, because the Console saves with `ifDigest`:

```ts [server/agents/editor.ts] fragment
content({ lease: 'override' })
```

`content_publish` and `content_schedule` do not check leases. They publish the reviewed digests, so a save after review fails them with `WORKSPACE_CONFLICT`.

## Access and approval

Each check calls `content.can({ user, actor, collection, action, id })`. `actor` is the Invocation's Invoker. `user` is the Auth user that Invoker stands for: [`authenticated()`](/docs/agents/trusted-invokers) from `vite-hub/auth/agent` records the user id as `invoker.meta.authUserId`, and the Capability reads that user from the Auth database through the `auth` primitive. It reads the user again when an approved call runs, so a role removed in the meantime takes effect. An anonymous Invoker, an Invoker without `authUserId`, an app without Auth, or a deleted user gives `user: null`. One `authorize` policy then covers the Console and the Agent, and it can check `actor` to give the Agent less than the user it acts for.

Reads check `read` per document on both refs, also for published documents. Lists, search results, totals, statuses, and schedules never show a document that `authorize` hides, and `content_get_document` denies it. A schedule shows only if the user may read all its documents. To let an Agent read what the site serves, return `true` for `read`.

Without `authorize`, `content.can()` returns `false` and the Agent can do nothing. A denied call fails with `CAPABILITY_DENIED` and runs nothing.

When your users live outside ViteHub Auth, map the Invoker yourself with `user`. It replaces the Auth lookup:

```ts [server/agents/editor.ts] fragment
content({
  user: async invoker => invoker.kind === 'authUser' ? await findMember(invoker.id) : null,
})
```

### The user of a chat

The user follows the Agent's [`invoker`](/docs/agents/trusted-invokers), so the same Auth that signs people in to your app decides who an Agent acts for:

| Entry point | Invoker | `user` in `authorize` |
| --- | --- | --- |
| HTTP chat or Agent route, with `invoker: authenticated()` | The signed-in person, as `kind: 'authUser'` with `meta.authUserId` | The Auth user |
| The same route without a session, with `authenticated({ required: false })` | Anonymous | `null` |
| A Channel, such as Discord or Slack | `kind: 'chat'`, with the platform user id | `null`, unless your `invoker` maps it |
| An Agent without `invoker` | Anonymous, or the trusted `context.invoker` of a custom route | `null`, unless the Invoker has `meta.authUserId` |

```ts [server/agents/editor.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { content } from 'vite-hub/agent/capabilities'
import { authenticated } from 'vite-hub/auth/agent'

export default defineAgent({
  invoker: authenticated({ required: false }),
  driver: { model },
  capabilities: [content()],
})
```

A Channel message has no session. Its Invoker names the platform user, and `authorize` receives it with `kind: 'chat'` and `user: null`. To act for an Auth user, map the platform user in `invoker.resolve`, for example through an account the person linked when they signed in:

```ts [server/agents/editor.ts] fragment
invoker: {
  async resolve({ defaultInvoker }) {
    if (defaultInvoker.kind !== 'chat') return
    const authUserId = await findLinkedUser(defaultInvoker.id) // your lookup, such as 'discord:123' -> 'user_1'
    return authUserId ? { ...defaultInvoker, meta: { ...defaultInvoker.meta, authUserId } } : undefined
  },
},
```

::warning
Do not grant `write` or `publish` to an unmapped chat identity.
::

`content_publish`, `content_schedule`, and `content_unschedule` use `policy: 'require-approval'`. The call stops with `APPROVAL_REQUIRED` and an Approval Request that shows the input, such as documents and digests, and runs after approval. `content_save_draft` needs none, because drafts are not served. `policy` replaces all four defaults. A function gets `{ name, input }`:

```ts
import { content } from 'vite-hub/agent/capabilities'

content({
  policy: ({ name }) => name === 'content_save_draft' ? 'allow' : 'require-approval',
})
```

The tools check `content.can()` before the policy, so a denied call fails at once without waiting for an approver. They check again when the approved call runs. Approval cannot grant what `authorize` denies.

Saves, publishes, schedules, and cancellations record `metadata.agent = { name, actor }` and, when `authorize` received a user, `metadata.author = { id, name, email }`, as Console saves do. [`content.revisions()`](/docs/content/server-api#revisions), [`content.schedules()`](/docs/content/scheduling#inspect-and-cancel), and the Console history then show the person, the Agent, and the Invoker of each change.

## Verify the tools

1. Run `vitehub agent info --agent editor --json`. Check that `tools` has a `content` entry with the expected commands, and `capabilities` has `{ id: "content" }`.
2. Ask the Agent to draft a post. Check that `content_save_draft` returns `ok: true` and `content.collection('posts').status('<id>')` reports `draft`.
3. Ask it to publish. Approve the request, then read the post from `/api/content/get/posts/<id>`.
4. Ask it to schedule a change for tomorrow. Approve the request, then check that `content.schedules()` lists it.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `collections` | `string[]` | every collection | Collections and singletons the Agent may use. An unknown name fails when the tools resolve. |
| `operations` | `Array<"read" \| "write" \| "publish">` | `["read", "write", "publish"]` | Tool groups to expose. Without `read`, the Agent can only create documents, because saving over a draft needs its digest. |
| `policy` | `AgentToolPolicyDecision \| (context) => AgentToolPolicyDecision \| Promise<AgentToolPolicyDecision>` | save `allow`, publish, schedule, and unschedule `require-approval` | Replaces the policy of `content_save_draft`, `content_publish`, `content_schedule`, and `content_unschedule`. |
| `user` | `(invoker) => user \| null \| Promise<user \| null>` | the Auth user from `invoker.meta.authUserId`, or `null` | Maps the Invoker to the `user` that `authorize` receives, instead of the Auth lookup. |
| `lease` | `"override"` | honor leases | Lets `content_save_draft` save while a person holds the edit lease. |

The Capability reports `mode: 'write'` when `write` or `publish` is enabled. Its metadata lists `collections`, `operations`, `approval`, and `lease` when set.

## Limits

- The Capability does not remove or restore documents. Call `remove()` and `restore()` from application code or a [Custom Capability](/docs/agents/capabilities/custom).
- Approval covers the listed digests. A save between the call and its run fails the publish or schedule with `WORKSPACE_CONFLICT`, so unreviewed content never goes live. The Agent must ask for a new approval.
- A scheduled publish needs a runner that calls `content.publishDue()`. See [Scheduling](/docs/content/scheduling#run-due-schedules).
- Each list and status call runs `authorize` once per document in the collection.
- Resolving the Auth user reads the Auth database once per Invocation.
- Document bodies are untrusted data. The tool descriptions tell the model so, but `authorize` is the real boundary.
- Collections need a Workspace with retained history, which needs a Database. The Capability does not work in standalone Agent builds without a host runtime.

## Other operations

`content()` tools are written for a model. For any other [operation](/docs/development/operations), use `operations({ include: ['content.*'] })`. Each operation becomes a tool named after it (`content_publish`). It checks `content.can()` with the same user and actor, and asks approval for destructive operations, except a dry run. It also runs `console.authorize` and drops operations of denied sections. Without `console.authorize`, `include` is the only gate. `content.save`, `content.remove`, and `content.restore` take `lease: 'override'` from an Agent or MCP client only with `operations({ overrideLeases: true })`. `content()` keeps its own `lease: 'override'` option.

## Related pages

- [Content configuration](/docs/content/configure)
- [Content server API](/docs/content/server-api)
- [Scheduling](/docs/content/scheduling)
- [Operations](/docs/development/operations)
- [Editing together](/docs/content/editing-together)
- [Trusted Invokers](/docs/agents/trusted-invokers)
- [Official capabilities](/docs/agents/capabilities/official)
- [Runtime policy, approvals, and traces](/docs/agents/runtime-policy)
