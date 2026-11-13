---
title: Invocation storage
description: Retain Invocation records, select a store, redact content, and recover or inspect recorded work.
navigation.order: 71
navigation.group: Advanced
navigation.kind: Reference
icon: i-lucide-database
---

An Invocation is one run of an Agent. The Invocation journal logs each run's status, metadata, and chosen trace content, so you can inspect runs in the CLI and the Console. To run or stream an Agent, read [Invocations](/docs/agents/invocations) first.

The journal gives the model no conversation context. Use [Chat History](/docs/agents/chat-history-sessions) or [Memory](/docs/agents/capabilities/memory) for that. If your app uses [Database](/docs/database), start with `invocations: 'database'`. If the host gives you a separate store, use the direct SQLite or D1 adapter. Choose content and retention settings before you store real conversations.

## Store invocation history

An Agent Definition that sets no `invocations` records into the [default journal](#use-the-default-journal), with the [Console](/docs/development/console) on or off. Set `invocations` on the Agent Definition to choose another journal:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations: 'database',
})
```

| Value | Journal |
| --- | --- |
| Omitted | The app-wide journal: [`agent.invocations`](#use-one-journal-for-every-agent), or the [default journal](#use-the-default-journal). |
| `'database'` | The `default` [ViteHub Database](/docs/database). |
| `'memory'` | Process memory. Lost on restart, not shared between replicas. |
| `false` | No journal, also not the app-wide one. |
| `{ store: 'database' \| 'memory', ...options }` | A built-in store with journal options. |
| `{ store }` or `defineAgentInvocations({ store })` | A custom `AgentInvocationStore`. |

The object form accepts every `defineAgentInvocations()` option except `store`. Set `database` to use another Database. It works only with `store: 'database'`:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations: { store: 'database', database: 'journal', content: 'content' },
})
```

ViteHub creates one journal per Agent Definition, not per request. The Database store connects on its first operation. Durability and recovery depend on the store and the host lifecycle.

## Use the default journal

When an app has Agents and sets no journal, ViteHub installs the default journal from `@vite-hub/agent`. It is the same journal with the Console on or off, so turning the Console on does not change where Invocations are stored. The Console only reads it.

| Host | Default journal |
| --- | --- |
| Development and Node | Local SQLite at `.vitehub/data/agent-invocations.sqlite` in the project root |
| Cloudflare production build | The D1 binding of the default or only Database Definition, table `vitehub_agent_invocations` |
| Cloudflare without a Database Definition | Memory of the Worker isolate |

The default journal keeps prompts, messages, final text, tool input and output, progress updates, and generated session titles, so the Console and the CLI can show them. It suits development and Node hosts with a persistent filesystem. A local file is local to one replica. Vercel and Nitro-hosted Deno production deployments should set a durable journal, such as `agent.invocations: 'database'` or a remote libSQL `databaseUrl`. A production build for these hosts logs a warning while it uses the local file.

The default journal requires Nitro-hosted Agents. For the Netlify host or `agent.runtime: 'deno'`, set `agent.invocations: false` and configure `invocations` on each Agent Definition. These standalone outputs reject an omitted or configured app-wide journal with `VITE_HUB_R0132`, including a remote `databaseUrl`.

Set its options in `agent.invocations`:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    agent: {
      invocations: {
        databaseUrl: 'file:/var/lib/my-app/agent-invocations.sqlite',
        retention: { maxAge: '14d', maxSize: '30%' },
        observations: { maxCount: 1024, flushTimeoutMs: 10000 },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [vitehub({
    agent: {
      invocations: {
        databaseUrl: 'file:/var/lib/my-app/agent-invocations.sqlite',
        retention: { maxAge: '14d', maxSize: '30%' },
        observations: { maxCount: 1024, flushTimeoutMs: 10000 },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    agent: {
      invocations: {
        databaseUrl: 'file:/var/lib/my-app/agent-invocations.sqlite',
        retention: { maxAge: '14d', maxSize: '30%' },
        observations: { maxCount: 1024, flushTimeoutMs: 10000 },
      },
    },
  })],
})
```
:::
::

- `databaseUrl` takes a `file:` or libSQL URL. A relative `file:` path resolves from the ViteHub project root. On the Cloudflare host, a remote libSQL URL replaces D1, and a `file:` URL fails the production build with `VITE_HUB_B0021`, because a Worker cannot open a local file.
- `retention` takes the [retention limits](#set-retention-limits). The SQLite and libSQL default journal keeps every terminal record by default. The D1 default journal defaults to 30 days and 10,000 terminal records. It does not support `maxSize` and fails the build with `VITE_HUB_B0016`. An invalid limit fails the build with `VITE_HUB_B0015`.
- `observations` takes the [observation bounds](#bound-observation-storage).

`VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` moves the journal at runtime and wins over `databaseUrl` and D1. Authenticated libSQL endpoints also need `VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN`:

```dotenv [.env]
VITEHUB_AGENT_INVOCATIONS_DATABASE_URL=libsql://my-database.turso.io
VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN=secret-token
```

On the Cloudflare host, a production build includes the libSQL client only when `databaseUrl` is set. A Worker that stores the journal in D1 or memory does not ship it, so `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` throws `AGENT_R1036` there. To move such a Worker to libSQL at runtime, set `databaseUrl` to a libSQL URL in the build. The variable still wins over it.

The server opens the journal on the first record or read, so libSQL does not load at server start. Read it in server code with `getAgentInvocations()` from `vite-hub/agent`. `await getAgentInvocationsDatabase()` from `vite-hub/agent/invocations/drizzle` opens Drizzle over the same database for queries and `db.batch()` writes. Check `driver` before you destructure `db` and `schema`. D1 inserts require non-null `search` and `summary`, and the D1 `db.transaction()` method rejects. It resolves to `undefined` when `agent.invocations` selects another store or `false`, and for the memory journal of a Worker.

Earlier releases kept this journal in the Console, at `.vitehub/data/console.sqlite`, with `console.databaseUrl`, `console.retention`, `console.observations`, and `VITEHUB_CONSOLE_DATABASE_URL`. These options are removed, and ViteHub does not move the old records. Set `databaseUrl` to the old file to keep reading it.

### AGENT_R1029: Local file on a Cloudflare Worker

The Worker rejects a selected `file:` URL at server start, including a `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` override. Set a remote libSQL URL, or remove the file URL to use the host default journal. This prevents the override from silently replacing D1 with memory.

### AGENT_R1036: libSQL journal without the libSQL driver

The default journal selected a SQLite file or a libSQL URL, but the server was built without the libSQL client. A Cloudflare production build without `agent.invocations.databaseUrl` leaves the client out, because its journal is D1 or memory. Set `databaseUrl` to the libSQL URL in the build, or remove `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` to use D1 or memory.

## Use one journal for every Agent

To give every Agent the same journal, set `agent.invocations` in the ViteHub options:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    database: { driver: 'd1' },
    agent: { invocations: 'database' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'cloudflare',
    database: { driver: 'd1' },
    agent: { invocations: 'database' },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'cloudflare',
    database: { driver: 'd1' },
    agent: { invocations: 'database' },
  })],
})
```
:::
::

The app-wide journal applies to Agent Definitions that do not set `invocations`. An Agent's own `invocations` value replaces it, and `invocations: false` turns it off for that Agent.

`agent.invocations` accepts `'database'`, `'memory'`, `false`, the [default journal options](#use-the-default-journal), and the object form without the `redact` and `redactError` functions. Set those functions on the Agent Definition. `'database'` requires `database` in the ViteHub options. Every app-wide journal requires Nitro-hosted Agents. For Netlify and Deno Agent output, set `agent.invocations: false` and configure journals on each Agent Definition. `false` records no app-wide journal. When the Console is enabled, it shows the app-wide journal.

## Use a custom store

Pass a store to `defineAgentInvocations()`. The SQLite adapter accepts a local SQLite or remote libSQL URL:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const invocations = defineAgentInvocations({
  store: createLibsqlAgentInvocationStore({
    maxAge: '30d',
    maxRecords: 10_000,
    maxSize: '2GB',
    url: 'file:./.data/invocations.db',
  }),
})

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations,
})
```

A local file gets WAL mode and `synchronous = NORMAL`: a process crash keeps committed updates, but a power loss can drop the latest ones. Remote libSQL URLs keep their own settings.

An observation is one trace event, such as a tool call. During a run, each one gets its own row in `vitehub_agent_invocations_observations`, so updates do not rewrite the record. The terminal update (the one that ends the run) moves them into the `record` column. If you query tables directly, read running records through `invocations.get(id)`.

`invocations.getSummary(id)` reads metadata without observations, or `undefined` for a missing Invocation. `get(id)` returns the full record. Every `AgentInvocationStore` must implement `getSummary(id)`.

### Rules for a custom store

- **Claims.** Enforce `claim(id, claimId, leaseMs, { expectedClaimIds })` atomically. Unless `replaceExisting` is `true`, it claims an unclaimed record or replaces a listed claim ID, and rejects any other owner, even an expired one.
- **Release.** `release(id, claimId)` releases only that claim ID. Journals rotate claim IDs on handoff and after an uncertain renewal, so a timed-out attempt's cleanup cannot release a newer claim.

The memory, libSQL, and D1 stores follow these rules.

An update with `reopen: true` moves a `failed` record to `pending` and clears `error`, `failedAt`, and `retryPending`. Other records stay unchanged. The webhook queue sends it when it retries a failed delivery, and `applyAgentInvocationStoreUpdate()` applies it. A store that returns the unchanged `failed` record keeps terminal reuse. An unconfirmed reopen blocks dispatch until confirmed.

A failed queued attempt with another attempt left sets `retryPending: true`. Cancelling such a record makes it `cancelled`, records `cancelRequestedAt` and `cancelledAt`, and clears `error`, `failedAt`, and `retryPending`, so the next attempt cannot reopen it. Other terminal records keep their usual cancellation behavior. Custom stores can apply these transitions atomically with `applyAgentInvocationStoreUpdate()`.

To read only some observations, pass `observationNames`:

```ts fragment
const record = await invocations.get(invocationId, {
  observationNames: ['agent.invocation.finish'],
})
```

Names match exactly and keep journal order. Other fields stay the same. An empty array returns no observations; omitting it returns all. Both forms return `undefined` for a missing Invocation.

To read only new observations, pass `afterSequence`. Each observation has a `sequence` number. Give the `sequence` of the last observation that you read:

```ts fragment
const record = await invocations.get(invocationId, {
  afterSequence: lastSequence,
})
const next = record?.observations.at(-1)?.sequence ?? lastSequence
```

The result has only observations with a greater `sequence`. `0` returns all observations. A reader on another instance, such as the Console or a stream reader, can poll a running Invocation this way and not read the whole record again. You can use `afterSequence` with `observationNames`; the result then matches both. A value that is not a non-negative integer fails with `AGENT_R1039` before the store reads.

The store can still add an observation with a lower `sequence` later, for example from a second writer, and size limits can drop observations. A follower can miss these observations. If you need every observation, read the whole record once when the Invocation ends.

D1 and libSQL filter in storage, so only the selected observations leave the database. The memory store filters before it copies the record. Custom stores can ignore the read options, because the wrapper still filters the result.

## Set retention limits

Retention keeps the journal from growing forever. By default, the SQLite adapter keeps at most 10,000 terminal records (completed, failed, or cancelled) from the last 30 days. Pending and running records stay until they end. Retention takes an `AgentRetentionPolicy`:

| Limit | Value | Default |
| --- | --- | --- |
| `maxAge` | A duration such as `'14d'`, `'12h'`, `'30m'`, or `'1.5h'` (units `ms`, `s`, `m`, `h`, `d`, `w`), or a number of milliseconds | `'30d'` |
| `maxRecords` | A positive integer | `10_000` |
| `maxSize` | A size such as `'500MB'` or `'3 GB'` (units `B`, `KB`, `MB`, `GB`, `TB`, 1024-based, any case), a number of bytes, or a percent such as `'30%'` | `false` |

All set limits apply together, and the oldest terminal records go first. `false` turns a limit off.

An invalid value, including `null`, fails at store creation with `AGENT_R0632` (SQLite) or `AGENT_R0911` (D1 and Database). `maxAgeMs` is not a store option.

Age and count retention run when a record is created or ends, so a quiet journal can keep expired records. The age limit reads only what it deletes. The count limit reads about `maxRecords` rows, so SQLite and D1 run it on about 1 in `ceil(maxRecords / 100)` of these writes, and the count can exceed `maxRecords` by about 1%. `invocations.prune()` applies every limit at once.

### Limit the file size

`maxSize` limits the live data (pages minus free pages) of the whole database file, so give the journal its own file: other tables count too. A percent is a share of the volume's capacity, read with `statfs` and cached for 10 minutes, but only this file's bytes count. Only a local SQLite file supports `maxSize`. A remote libSQL URL fails at store creation, and an in-memory database on its first operation, both with `AGENT_R0632`.

After a create or terminal update, the adapter measures the file once the bytes written reach the larger of 64 KiB and 1% of the budget, or after 60 seconds with writes. Over budget, it deletes the oldest terminal records in batches until the data fits. It never deletes pending or running records, so a journal of active records can stay over. A failed check logs a warning and does not fail the write.

Deletes free pages inside the file. The file shrinks only with `auto_vacuum = INCREMENTAL`, which the adapter sets on new files, and a size prune then returns up to 1,000 free pages. An older file keeps its largest size until a `VACUUM`, and reuses its free pages.

Run [`vitehub agent invocations compact`](#compact-a-journal-file) once to rebuild such a file and set the mode. Later prunes then shrink it.

## Choose how storage failures affect a run

By default, a slow or unavailable store does not stop a run, because the journal is only history for the Console and CLI. Set `enforcement` to change this:

```ts fragment
const invocations = defineAgentInvocations({
  enforcement: 'strict',
  store,
})
```

| `enforcement` | When the store does not confirm a startup operation |
| --- | --- |
| `'best-effort'` (default) | The run starts. The journal retries in the background and logs one warning. |
| `'strict'` | The run does not start. |

Each store operation uses `storeTimeoutMs` (default 1,000 ms, range 1 to 60,000). A timeout, rejection, or missing result is not a confirmation.

Before the Driver (the part that does the work) starts, a run needs the execution claim, the `running` state, and the first cancellation check. In best-effort mode, the journal retries `running` for up to 60 seconds and rereads cancellation every 10 seconds. A failed write never changes the run's result. A run still stops when the store reports another claim owner (it fails with `Could not persist the Invocation running state.`) or returns a cancellation request (it becomes `cancelled`).

For a custom `run` Driver, strict mode also needs the cancellation warning state before dispatch. Best-effort starts without it, and a remote `cancel()` can throw `AGENT_R0974` until that write succeeds.

::warning
Best-effort history can be missing or stale. Until a retry succeeds, a record can stay `pending` without `startedAt` or observations, and an unrecovered store may have no record at all. Keep product results in your own data. If the store does not answer, two runs with one run ID can both start. Use `'strict'` when the journal claim is your only duplicate guard.
::

Channel replay is always strict: `replayChannel()` and `dispatchChannelItems()` rely on the journal claim to avoid duplicate runs, and so does a Workflow worker that receives a replay claim. Other Workflow runs follow `enforcement`.

Live Channel webhooks do not rely on the journal. The route claims each delivery ID with `setIfNotExists()` in the State Adapter, and Chat SDK Channels such as Telegram skip repeated message IDs there. So a provider retry starts no second run, even in best-effort mode.

## Store invocations in a ViteHub Database

`invocations: 'database'` uses the Database adapter with defaults. For options such as retention, use it directly:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { createDatabaseAgentInvocationStore } from 'vite-hub/agent/invocations/database'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const invocations = defineAgentInvocations({
  store: createDatabaseAgentInvocationStore({
    database: 'default',
    maxAge: '30d',
    maxRecords: 10_000,
  }),
})

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations,
})
```

The adapter looks up the named Database per operation and creates the journal tables on first use. It supports local SQLite, hosted libSQL through Drizzle, and a native Cloudflare D1 binding. It supports `maxAge` and `maxRecords`, but not `maxSize`, because the Database holds other tables. Set `database` to use another discovered Database. It does not open, close, or migrate an existing custom journal. It applies the D1 rules everywhere, including the 1,000,000-byte observation cap and the 1,900,000-byte row budget. See [D1 row limits](#store-invocations-in-cloudflare-d1) for truncation and rejected writes.

Use the direct SQLite adapter when the journal has its own URL, the [`d1` adapter](#store-invocations-in-cloudflare-d1) when the Agent gets a D1 binding, and the Database adapter, the portable choice, when the host already selects the Database.

## Delete or prune records

To delete or prune terminal records:

```ts fragment
await invocations.delete(invocationId) // 'deleted' | 'not-found' | 'not-terminal'
await invocations.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000, dryRun: true })
await invocations.prune() // applies the store's maxAge, maxRecords, and maxSize now
```

`delete(id)` skips pending and running records and returns `'deleted'`, `'not-found'`, or `'not-terminal'`. It removes the record and its claim.

`prune()` returns `{ dryRun, ids, size? }`. With `olderThanMs`, it selects terminal records last updated before the cutoff. The age must be a non-negative safe integer within JavaScript's Date range, or it fails with `AGENT_R0929`. Without it, the store's retention applies. With `maxSize`, prune also applies that limit and returns `size: { beforeBytes, afterBytes, budgetBytes }`. `dryRun: true` only lists IDs: SQLite size pruning rolls back a transaction, and D1 only selects.

The SQLite, D1, and memory stores support both operations. Custom stores need `store.delete()` and `store.prune()`. Your app owns retention of files that a Capability (a tool or behavior add-on) writes to Blob storage, because they are not keyed by the journal record.

## Rerun a recorded prompt

To run a finished Invocation again, read its recorded prompt:

```ts fragment
import { agentInvocationRerunInput, runAgent } from 'vite-hub/agent'

const record = await invocations.get(invocationId)
const input = record ? agentInvocationRerunInput(record) : undefined
if (input?.available) {
  const [error] = await runAgent(agent, {
    prompt: input.prompt,
    ...(input.invokerProfileId ? { context: { invokerProfileId: input.invokerProfileId } } : {}),
  }, { runtimeContext })
  if (error) throw error
}
```

When the record cannot reproduce its input, the result has `available: false` and a `reason`:

| Reason | Input that cannot be reproduced |
| --- | --- |
| `invocation-not-terminal` | The record is pending or running. |
| `input-not-captured` | The prompt was not retained. |
| `replay-metadata-unavailable` | Replay metadata is missing or incomplete. |
| `input-has-invoker` | A direct Invoker identity, or a resolver-derived Invoker without a selected Invoker Profile. |
| `input-has-data` | Structured input. |
| `input-has-options` | Call options. |
| `input-has-messages` | A singular Message or prior Messages. |
| `input-redacted` | Changed input or Invoker Profile replay metadata. |
| `input-truncated` | A bounded prompt. |
| `input-has-context` | Direct context beyond an Invoker Profile selection. |
| `input-has-run-metadata` | Runtime run metadata beyond the run ID. |
| `input-has-timeout` | A timeout. |
| `input-has-dry-run` | Dry-run mode. |
| `input-has-abort-signal` | A caller-provided cancellation signal. |
| `input-prompt-changed` | A Capability or input hook changed the prompt. |

The journal keeps `input.prompt` only when `metadataContent` or `content: 'content'` includes it. An Invoker Profile (a saved run identity) is resolved again when the new Invocation starts. `invokerProfileId` holds the profile ID from the start observation, even if a resolver changed the identity. Direct identities, structured input, and call options are not replayed. [Channel history replay](/docs/agents/channels#replay-channel-history) is different: it uses Channel item identities and strict claims.

## Choose what to retain

A journal keeps only metadata by default.

- `configuration: 'content'` keeps resolved instructions and tool descriptions and schemas, apart from other trace content. The default is `'metadata'`. The default Agent journal turns it on. Older records cannot get it back. It follows the observation limits and marks truncated values.
- `content: 'content'` keeps prompts, messages, reasoning, tool inputs and outputs, and result text. Set it only when your app must keep them.

::warning
`content: 'content'` puts sensitive model content in a durable store. Give it the same access control, retention, and encryption as the source data.
::

## Redact stored evidence

`redact` rewrites or drops an observation before the store gets it. `redactError` rewrites a failed record's error:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { createDatabaseAgentInvocationStore } from 'vite-hub/agent/invocations/database'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const invocations = defineAgentInvocations({
  store: createDatabaseAgentInvocationStore(),
  redact(observation) {
    if (observation.name === 'agent.tool.result') return undefined
    const { 'tool.input': _input, ...attributes } = observation.attributes ?? {}
    return { ...observation, attributes }
  },
  redactError: error => ({ message: error.message, name: error.name }),
})

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations,
})
```

`redact` runs after the content policy and before size limits, on streamed and persisted observations and `appendObservation()` evidence. Return `undefined` to drop it. If `redactError` returns `undefined`, the record stays `failed` with no error details. Both hooks are synchronous.

## Inspect retained records

The journal records pending, running, completed, failed, and cancelled states, with bounded metadata and observations. Failed records keep bounded `cause` and `AggregateError.errors` trees, status and code fields, and public ViteHub error details.

`invocations.list()` returns paged summaries with a cursor. `invocations.get(id)` reads one record. `invocations.getByRunId(runId, agentName?)` reads by source run ID. Pass the name for a named Agent, because it is part of the durable identity.

Trace write failures do not change the result. With `enforcement: 'strict'`, a rejected, missing, or timed-out first cancellation check fails startup with `AGENT_R0973`. See [Choose how storage failures affect a run](#choose-how-storage-failures-affect-a-run).

`triggeredBy` filters summaries by the person label in `annotations.triggeredBy`, matching the trimmed label exactly. It combines with Agent, Capability, status, and text filters:

```ts fragment
const people = await invocations.listTriggeredBy('support')
const page = await invocations.list({
  agentName: 'support',
  triggeredBy: 'Alex',
  limit: 50,
})
const nextPage = page.cursor
  ? await invocations.list({
      agentName: 'support',
      triggeredBy: 'Alex',
      limit: 50,
      cursor: page.cursor,
    })
  : undefined
```

`listTriggeredBy(agentName?)` returns sorted, distinct, trimmed, non-empty labels, across all Agents without a name. Records without a label do not match a non-empty filter, and a blank filter is ignored. Keep the same filters when you follow a cursor. A custom store can implement `listTriggeredBy()`; otherwise the wrapper pages through summaries.

## Bound observation storage

Set limits for long traces with `observations`:

```ts
import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const invocations = defineAgentInvocations({
  content: 'content',
  observations: {
    maxCount: 512,
    maxStringLength: 256 * 1024,
    maxBytes: 2 * 1024 * 1024,
    flushTimeoutMs: 10_000,
  },
  store: createLibsqlAgentInvocationStore({ url: 'file:./.data/invocations.db' }),
})
```

| Option | Default | Maximum |
| --- | --- | --- |
| `maxCount` | 32,768 observations | 32,768 observations |
| `maxStringLength` | 65,536 UTF-16 code units of content strings per observation value budget | 1,048,576 code units |
| `maxBytes` | 16 MiB of serialized observation data | 64 MiB |
| `flushTimeoutMs` | 1 second finish drain | 60 seconds |

The byte limit counts the UTF-8 observations array after privacy filtering, not provider output, the live trace log, or process memory. A resumed record keeps its limits.

At a limit, the journal marks `observationsTruncated` and keeps lifecycle outcomes before ordinary observations, stripping large outcome content if needed. A shortened or dropped value adds `vitehub.observation.truncated: true` and the attribute names in `vitehub.observation.truncatedAttributes`. Metadata strings keep 512 characters, and `agent.run.id` the content string limit. When an input history loses only part data it does not show, such as a message header, the list names `input.messages.parts` instead of `input.messages`.

`flushTimeoutMs` sets how long finish waits for queued observations. A longer drain helps a long queue of working writes, not an unavailable store.

An operation slower than `storeTimeoutMs` (default one second, maximum 60) counts as unconfirmed, even if it lands later. In `strict` mode, an unconfirmed running transition stops the Invocation before the Driver starts. `best-effort` starts it and retries. Raise the limit for a distant store, such as a D1 primary in another region:

```ts
import { createDatabaseAgentInvocationStore } from 'vite-hub/agent/invocations/database'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const invocations = defineAgentInvocations({
  store: createDatabaseAgentInvocationStore(),
  storeTimeoutMs: 10_000,
})
```

A store that connects on first use, such as one that loads its database client and creates its tables, can implement `open()`. The journal calls it once before its first operation and waits up to 10 seconds for it, outside `storeTimeoutMs`, so a slow cold start does not make the first operation unconfirmed. Concurrent callers share the underlying open, even after a wait times out. Only a rejected open is retried. The libSQL store and the default Agent journal implement it.

## Inspect and maintain from the CLI

When an app exposes the standard journal route, inspect it from the terminal:

```sh
vitehub agent invocations list --status running
vitehub agent invocations show INVOCATION_ID
vitehub agent invocations tail INVOCATION_ID
```

The CLI defaults to `http://localhost:5173/api/invocations`. Use `--url` or `VITEHUB_AGENT_INVOCATIONS_URL` for another endpoint, and `--json` for scripts. `vitehub agent invocations cancel INVOCATION_ID` cancels inside the Nitro runtime of a Vite + Nitro Development Server. With a deployed `--url`, such as `https://app.example.com`, `list`, `show`, `tail`, and `cancel` use that deployment's Console.

See [Cancel an Agent Invocation](/docs/development/cli#cancel-an-agent-invocation) and [Inspect and cancel on a deployed app](/docs/development/cli#inspect-and-cancel-on-a-deployed-app).

Before a rollout, wait until nothing is pending or running, so the restart interrupts no work:

```sh
vitehub agent invocations wait-idle --url https://app.example.com --timeout 30m
```

`wait-idle` reads the same target as `list` and prints what it waits on. It exits 0 when idle, or 1 when `--timeout` (default `30m`) passes first. A crashed process can leave a record running, so a record not updated for `--stale-after` (default `2h`) is reported but does not block. `--interval` sets polling (default `5s`), `--agent` limits it to one Agent, and `--json` prints one `invocations.waiting`, `invocations.idle`, or `invocations.timeout` event per line.

Export Invocations as JSON Lines for offline analysis or evals:

```sh
vitehub agent invocations export --url https://app.example.com --origin webhook --since 7d > invocations.jsonl
```

`export` reads the same target as `list` and prints one line per Invocation, oldest first: the record without observations, plus `prompt` and `runId` from `agent.invocation.start`, `final` (the final assistant text), and `deliveries`, each `agent.channel.delivery.effect` with its `channel`, `kind`, `intent`, `content`, and `skipped` reason. `--status`, `--origin`, and `--agent` select records. `--since` takes an age such as `7d` or a date such as `2026-10-01`. `--observations` adds every observation. Fields appear only if the journal kept them, so content settings decide whether `prompt`, `final`, and delivery content appear.

`--activity` adds a compact trace of what the Agent did, so you can see which tools ran, which failed, and where tokens went without the full observations:

```sh
vitehub agent invocations export --database /data/agent-invocations.sqlite --since 7d --activity > activity.jsonl
```

Each line then has `activity`, an array in observation order. Every entry has `at` (the time of its first observation) and `kind`:

| `kind` | Fields |
| --- | --- |
| `tool` | `id`, `name`, `title`, `status` (`running`, `completed`, or `failed`), `input`, `paths`, `exitCode`, `error`, `durationMs`, `outputBytes`, `output` |
| `message` | `phase` (`commentary` or `final`), `text` |
| `reasoning` | `text`, the reasoning summary that a provider Driver such as Codex streams |
| `usage` | `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `totalTokens`, `costUsd`, `model`, `provider` |
| `approval` | `id`, `name`, `approved`, `reason` |
| `error` | `message`, `recoverable` |

One `tool` entry joins the start, the streamed output, and the result of one call. `input` is the command for a shell call, without the `bash -lc` wrapper, or the input as JSON. `paths` lists the files of a file change. A call with a non-zero `exitCode` is `failed`. `outputBytes` is the UTF-8 size of the output that the journal kept. `output` appears only for a failed call. A `usage` entry is one token usage update, so a model Driver reports one per model step and Codex one per update.

The export bounds each trace:

- `input`, `title`, `text`, `error`, `message`, and `reason` keep their first 1,000 characters and end with `…[+N chars]`.
- `output` keeps the last 2,000 characters and starts with `[N chars+]…`.
- A trace keeps its first 1,000 entries. `activityOmitted` counts the others.

`recordTruncated: true` marks an entry whose content the journal shortened when it recorded it. `contentOmitted` lists `tool.input` or `tool.output` when the journal content policy did not keep them, so `input`, `exitCode`, and `outputBytes` can be absent. The trace has no per-tool token counts, because Drivers report usage per model step, not per tool call.

`delete` and `prune` open a SQLite or libSQL journal directly:

```sh
vitehub agent invocations delete INVOCATION_ID
vitehub agent invocations prune --older-than 30d --dry-run --json
vitehub agent invocations prune --database file:./.data/invocations.db --older-than 12h
vitehub agent invocations prune --database /data/agent-invocations.sqlite --max-size 30% --dry-run
vitehub agent invocations prune --max-records 1000 --max-size 2GB
```

- Without `--database` or `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL`, they use the default journal at `.vitehub/data/agent-invocations.sqlite` in the project root.
- Set `VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN` for an authenticated libSQL endpoint.
- Durations accept `ms`, `s`, `m`, `h`, `d`, and `w`. `--older-than` defaults to `30d`.
- With `--max-size` or `--max-records`, prune removes the oldest terminal records first, and `--older-than` applies only if passed.
- `--max-size` takes the same values as `maxSize` and prints live data before and after, and the budget.
- Use `--table-prefix` when the store sets `tablePrefix`.
- They refuse a missing file and never print URL credentials or tokens.
- For D1, call `invocations.prune()` from a Worker.

## Compact a journal file

A journal file created before the adapter set `auto_vacuum = INCREMENTAL` keeps its largest size. Run `compact` once to rebuild it with `VACUUM` and set the mode:

```sh
vitehub agent invocations compact --database /data/agent-invocations.sqlite --dry-run
vitehub agent invocations compact --database /data/agent-invocations.sqlite --json
```

`compact` measures the file, WAL, page count, free pages, and `auto_vacuum` mode, then runs `PRAGMA auto_vacuum = INCREMENTAL`, `VACUUM`, and `PRAGMA wal_checkpoint(TRUNCATE)`. It prints the size before and after, reclaimed bytes, and the new mode. `--dry-run` prints the measurements, projected size, and free space check without changes, and exits 1 when compact would refuse. Prune first, so the rebuilt file holds only what you keep.

- Only a local SQLite file works. A remote libSQL URL or in-memory database fails with `AGENT_R0931`.
- `VACUUM` writes a copy of the live data to the SQLite temporary directory, then a journal or WAL of about the same size next to the database. Compact refuses when a volume lacks 1.1 times the live data per file, plus the current WAL, counting both files on a shared volume. Set `SQLITE_TMPDIR` to put the copy elsewhere.
- `VACUUM` holds the write lock until done, so server writes wait. Stop the server or run it when quiet. If another process holds the lock over 5 seconds, compact fails without changes.

`list`, `show`, and `tail` can also read a SQLite journal file directly, without the app or Console, for example inside a running container:

```sh
vitehub agent invocations list --database /data/agent-invocations.sqlite --status running
vitehub agent invocations show INVOCATION_ID --database /data/agent-invocations.sqlite --json
```

It opens the file read-only with `node:sqlite` and never migrates or writes it, so the app can keep writing. It reads observations from the record and from the running-record table. It takes a path or `file:` URL, refuses remote libSQL (use `--url`), and honors `--table-prefix`. `cancel` still needs the running app. Without `node:sqlite`, it says so and exits 1.

## Host recovery limits

A Workflow is a durable runner that can retry steps after a crash. Journals also keep failures and cancellation during Workflow preparation, before provider dispatch. Fresh manual starts get distinct Invocation IDs. Durable Channel deliveries keep their run ID across preparation attempts.

Cloudflare and OpenWorkflow create the journal after durable recovery dispatch, and reconcile failures after the generated Agent module loads but before the handler starts. If that module cannot load, the store is unavailable: use Workflow inspection.

On Vercel, Agents run through the inline Workflow adapter, because Vercel's deterministic native Workflow bundle cannot embed arbitrary handlers. An accepted run starts its journal in the Agent worker, with bounded recovery inside the active execution. Vercel has no lifecycle hook that guarantees recovery after the execution settles, so treat this journal as best-effort and Workflow inspection as the authority. A synchronous start rejection is still recorded as failed. Run inspection reports `mode: "inline"`.

## Store invocations in Cloudflare D1

Use the D1 adapter when the app has a D1 database. The binding resolves per operation, so the Agent needs no request bindings at module load. `useDatabaseBinding()` returns the D1 binding of a [ViteHub Database](/docs/database/server-api#pass-the-d1-binding-to-other-code):

```ts [server/invocations.ts]
import { createD1AgentInvocationStore } from 'vite-hub/agent/invocations'
import { defineAgentInvocations } from 'vite-hub/agent/server'
import { useDatabaseBinding } from 'vite-hub/database/drizzle'

export const invocations = defineAgentInvocations({
  store: createD1AgentInvocationStore({
    database: () => useDatabaseBinding('default'),
    migrate: false,
    maxAge: '30d',
    maxRecords: 10_000,
  }),
})
```

With `cloudflare.readReplication`, `useDatabaseBinding()` returns a new D1 session for each request. The store's automatic setup runs once per database object, so leaving it enabled would run schema writes on the primary in every request. The example sets `migrate: false`; apply the schema with your deployment migrations before serving requests.

Print the schema statements with `d1AgentInvocationSchema()` and apply them to the D1 database:

```ts [scripts/invocation-schema.ts]
import { d1AgentInvocationSchema } from 'vite-hub/agent/invocations'

console.log(d1AgentInvocationSchema().join(';\n') + ';')
```

When using a stable D1 binding without request sessions, you can omit `migrate: false` to create the table and indexes on first use of each binding in a Worker isolate. The statements use `CREATE ... IF NOT EXISTS`, so concurrent isolates and existing tables are safe. A failed creation is retried on the next operation.

`tablePrefix` defaults to `vitehub_agent_`. Pass the same prefix to the schema function and the store. The table is outside your Drizzle schema, so `vitehub database generate` ignores it. The schema is new and ViteHub-owned. It does not convert a custom journal or libSQL tables, so keep an old journal until you migrate it.

- D1 batches make creation and retention atomic.
- Conditional updates retry when another Worker changes the record, so concurrent observations survive.
- Claims use the database clock and fence updates after ownership changes.
- After 32 write conflicts, an update rejects instead of overwriting.
- Retention defaults and observation deduplication match libSQL.
- `maxSize` fails with `AGENT_R0911`, because D1 reports whole-database size. Use `maxAge` and `maxRecords`.
- It supports Agent, Capability, triggering-person, status, and text filters, `listTriggeredBy()`, summaries without observations, and `get(id, { observationNames, afterSequence })`.

[D1 limits a row to 2 MB](https://developers.cloudflare.com/d1/platform/limits/), so the adapter caps observations at 1,000,000 UTF-8 bytes, shown in `observationLimits`, even if the journal asks for more. It also checks the full row, including summary and search text. If the row is too large, it drops ordinary observations and marks `observationsTruncated`, keeping lifecycle fields and appended evidence. If it still cannot fit, the update rejects before writing. Use another store for complete long traces.

For ViteHub-managed SQLite or libSQL, use the [Database adapter](#store-invocations-in-a-vitehub-database). The host owns the binding, and the store never opens or closes it. Use [`redact`](#redact-stored-evidence) to keep sensitive values out of D1. Route authorization stays your app's policy.

On the Cloudflare host, the [default journal](#use-the-default-journal) uses this store with the D1 Database binding when no Agent Definition configures `invocations`. Local D1 tests cover the SQL and concurrency contract; they do not measure production D1 limits or latency.

## Append delivery evidence

Use `appendObservation()` to record an external delivery before or after an Invocation finishes:

```ts fragment
const record = await invocations.appendObservation(invocationId, {
  name: 'report.delivered',
  type: 'capability',
  attributes: { 'report.id': reportId },
}, { id: `report-delivered:${reportId}` })
```

The observation ID is required, at most 512 characters, and stored once per Invocation, so retries are idempotent. The store assigns the sequence atomically. The append keeps the status and lease, applies the content policy, and returns the stored record, or `undefined` for a missing Invocation. A failed write or full capacity throws. If `redact` drops or fails, it returns the existing record without appending. Confirm your observation ID in the returned record.

Appends use the limits saved with the record, also after a restart. If count, byte, or row capacity would drop evidence, the append rejects without changes. Accepted appends survive later trace pressure until retention removes the Invocation. Retry an unknown result with the same ID. Custom stores must implement `appendObservation` on `AgentInvocationStoreUpdateInput`, or fail explicitly.

## Cancel an invocation

Call `invocations.cancel(id)` to cancel a pending or running Invocation. The journal records `cancelRequestedAt` first, so every process sharing the store sees it.

```ts fragment
const result = await invocations.cancel(id)
if (result.notEnforcedBy) console.warn(`Cancel requested, not enforced by ${result.notEnforcedBy}`)
```

| `outcome` | Meaning |
| --- | --- |
| `requested` | Recorded or sent locally. `delivery: 'local'`: a run in this process got an aborted signal. `delivery: 'journal'`: the store kept it for a current or future owner. Neither confirms a stop. Without a journal record, a local run still gives `requested` with local delivery. |
| `terminal` | `status` holds a final state. A stale Driver may still run. Local abort delivery and `notEnforcedBy` warnings stay in the result. A durable warning describes the Driver contract, not active execution. |
| `not-found` | No journal record and no local run. |
| `unavailable` | The store did not keep the request and no local run holds the Invocation. |

Runs check for a cancellation request before setup. In strict mode, a rejected, missing, or slower-than-`storeTimeoutMs` read fails startup with `AGENT_R0973`. In best-effort mode, the run starts and checks again at the next poll. A returned request always stops startup. After startup, runs check every 10 seconds, also after a lost lease stops claim renewal.

::warning
A crashed owner or expired lease does not prove that a Driver stopped. An orphaned record stays pending or running until recovery sees its request. Cancellation does not recover orphaned work or promise a deadline, and repeating it changes nothing. Read the final status to confirm.
::

The Development Server command `vitehub agent invocations cancel <id>` checks all registered journals first. If two journals hold the ID, it returns HTTP `409` and changes nothing; call `invocations.cancel(id)` on the right Agent instead. Shared journals are checked once. If any lookup fails, the request fails before cancelling, because uniqueness cannot be verified.

If the durable write fails, cancellation still aborts a local run and passes on the storage error, but other processes get no request.

After a lease replacement, a local abort can reach a stale owner, and results keep the current owner's durable Driver warning. The pending marker's `cancelWarningOwnerId` names its owner, and a local handle for another owner must verify it before reporting success. Custom stores keep both fields, and clearing `cancelWarningPending` clears the owner ID.

A cancel request aborts the Invocation signal, which stops the Driver capacity wait, the Driver, tool calls, queued webhook executions, and scheduled turns. A webhook failure caused by cancellation completes without retry. An unrelated failure still retries, even with an old cancel request. The record then becomes `cancelled` through `agent.invocation.cancelled`.

| Driver | Cancel |
| --- | --- |
| `model` | Enforced. The AI SDK request receives the abort signal. |
| `provider` (`claude-code`, `codex`) | Enforced. The provider session receives the abort signal. |
| `run` | Not enforced. The handler gets `context.input.abortSignal` and must stop itself. |

Cancellation before Driver dispatch stops startup without a `notEnforcedBy` warning.

For a custom `run` Driver:

- A new record stores `cancelWarningPending` until dispatch is verified. A reused record whose running update fails must confirm it before dispatch.
- After dispatch, the warning write retries for up to one minute.
- A canceller in another process waits up to five seconds for a durable warning or terminal record, else `cancel()` throws `AGENT_R0974`. The request is already recorded, so inspect the journal again.
- Terminal writes keep `cancelNotEnforcedBy`, even after a failed warning write.
- Custom stores keep `cancelWarningPending` on create and update, and clear it when `applyAgentInvocationStoreUpdate()` gets `false`.

When a started Driver does not enforce cancel, the result has `notEnforcedBy`, and the record keeps `cancelNotEnforcedBy` and `cancelRequestedAt`. It stays `running` until the Driver returns and is not reported as cancelled.

## Recover interrupted Invocations

A process that stops mid-run can leave records pending or running. Recovery marks them failed.

For a store that one process owns, `createProcessAgentInvocations` from `vite-hub/agent/process` recovers before it returns the journal. Pass the usual `defineAgentInvocations` options and `recovery: { recover(invocation) }`, which returns whether this process owns the Invocation. Use `recover: () => true` only when the database belongs to that service alone. A failed recovery rejects startup.

With a libSQL Agent state provider, a persistent Nitro server recovers each Agent journal when it resumes queued webhook deliveries, one second after start or on the first request that loads the Agent routes. It fails pending or running Invocations that started before the process, skips those that a queued delivery reruns under the same run ID, and skips Agents with a durable Workflow runtime. A failed recovery is logged, and the queue still resumes.

Then it retries each interrupted inline Chat turn once. A turn is interrupted when it started before the process and no live run holds the journal claim of its Invocation. A run renews its claim every 10 seconds, and a claim expires 30 seconds after its last renewal. Thus, when several processes share one journal and one Agent state, a process that starts does not run again a turn that another process still runs. When the journal has no record for the turn, or the journal check fails, the start time is the only test.

## Next steps

- [Observability](/docs/agents/observability) exports lifecycle events.
- [Evals](/docs/agents/evals) check behavior.
- The [Console](/docs/development/console) reads the configured journal. Its authorization stays your app's policy.
