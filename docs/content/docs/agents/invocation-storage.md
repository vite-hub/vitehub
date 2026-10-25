---
title: Invocation storage
description: Retain Invocation records, select a store, redact content, and recover or inspect recorded work.
navigation.order: 71
navigation.group: Advanced
navigation.kind: Reference
icon: i-lucide-database
---

An Invocation journal stores run status, metadata, and selected trace content for the CLI and Console. Use [Invocations](/docs/agents/invocations) to run or stream an Agent first. A journal is separate from [Chat History](/docs/agents/chat-history-sessions) and [Memory](/docs/agents/capabilities/memory); it does not supply the next model request with conversation context.

Start with `invocations: 'database'` when your app already uses [Database](/docs/database). Use the direct SQLite or D1 adapter when the host supplies a separate store. Choose content and retention settings before storing real conversations.

## Store invocation history

To keep a queryable invocation journal, set `invocations` on the Agent Definition. History is opt-in. An Agent without a journal records no Invocations, unless the [Console](/docs/development/console) supplies its own journal.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations: 'database',
})
```

| Value | Journal |
| --- | --- |
| `'database'` | The app's [ViteHub Database](/docs/database). It uses the `default` Database. |
| `'memory'` | Memory of the server process. Records do not survive a restart, and replicas do not share them. |
| `false` | No journal. This value also turns off the app-wide journal for this Agent. |
| `{ store: 'database' \| 'memory', ...options }` | A built-in store with journal options. |
| `{ store }` or `defineAgentInvocations({ store })` | A custom `AgentInvocationStore`. |

The object form accepts every `defineAgentInvocations()` option except `store`. Set `database` to select another Database name. `database` is valid only with `store: 'database'`:

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  invocations: { store: 'database', database: 'journal', content: 'content' },
})
```

ViteHub creates one journal for each Agent Definition, not one for each request. The Database store connects to the Database on its first operation. Storage durability and recovery guarantees depend on the selected store and the host lifecycle.

## Use one journal for every Agent

Set `agent.invocations` in the ViteHub options to give every Agent Definition the same journal:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    preset: 'cloudflare',
    database: { driver: 'd1' },
    agent: { invocations: 'database' },
  })],
})
```

In Nuxt, set the same value in the `vitehub` key of `nuxt.config.ts`. The app-wide journal applies to Agent Definitions from `vite-hub/agent` that do not set `invocations`. An Agent's own `invocations` value replaces it, and `invocations: false` turns it off for that Agent.

`agent.invocations` accepts `'database'`, `'memory'`, `false`, and the object form without the `redact` and `redactError` functions. Set those functions on the Agent Definition. `'database'` requires `database` in the ViteHub options. The app-wide journal requires Nitro-hosted Agents; Netlify and Deno Agent output fail the build. When the Console is enabled, it shows the app-wide journal.

## Use a custom store

Pass a store to `defineAgentInvocations()` when the built-in names do not fit. The SQLite adapter accepts a local SQLite or remote libSQL URL:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
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

For a local database file, the SQLite adapter sets the WAL journal mode and `synchronous = NORMAL`. A process crash does not lose committed updates, but a power loss can drop the latest commits. Remote libSQL URLs keep their own settings. While an Invocation runs, the adapter stores each new observation in its own row in the `vitehub_agent_invocations_observations` table, so an update does not rewrite the complete record. The terminal update moves all observations into the `record` column. If you query the tables directly, read running records through `invocations.get(id)`.

Use `invocations.getSummary(id)` to read metadata without observation payloads. It returns `undefined` when the Invocation does not exist. Every `AgentInvocationStore` must implement `getSummary(id)`; `get(id)` returns the full record.

Custom stores must enforce `claim(id, claimId, leaseMs, { expectedClaimIds })` atomically. Unless `replaceExisting` is `true`, this form can claim an unclaimed record or replace one of the listed claim IDs. It must reject a different owner, including an expired claim. Journals rotate the claim ID for handoff and after an uncertain renewal so cleanup of a timed-out attempt cannot release a newer claim. `release(id, claimId)` must release only that claim ID. The memory, libSQL, and D1 stores enforce these rules.

Pass `observationNames` to read only the observations needed for an inspection:

```ts
const record = await invocations.get(invocationId, {
  observationNames: ['agent.invocation.finish'],
})
```

Names match exactly, and matching observations keep their journal order. Other record fields remain unchanged. An empty array returns no observations; omitting `observationNames` returns all retained observations. Both forms return `undefined` for a missing Invocation. D1 and libSQL filter observation payloads in storage. Custom stores may ignore the optional read options; the Invocations wrapper still filters the returned record.

## Set retention limits

The SQLite adapter keeps at most 10,000 terminal records from the last 30 days by default. Pending and running invocations remain available until they reach a terminal state. Retention takes an `AgentRetentionPolicy`:

| Limit | Value | Default |
| --- | --- | --- |
| `maxAge` | A duration such as `'14d'`, `'12h'`, `'30m'`, or `'1.5h'` (units `ms`, `s`, `m`, `h`, `d`, `w`), or a number of milliseconds | `'30d'` |
| `maxRecords` | A positive integer | `10_000` |
| `maxSize` | A size such as `'500MB'` or `'3 GB'` (units `B`, `KB`, `MB`, `GB`, `TB`, 1024-based, any case), a number of bytes, or a percent such as `'30%'` | `false` |

All limits that are set apply together. The oldest terminal records go first until every limit holds. Set a limit to `false` to disable it. An invalid value for a supported limit, including `null`, fails when the store is created. The SQLite adapter reports `AGENT_R0632`; the D1 and Database adapters report `AGENT_R0911`. Use `maxAge`, `maxRecords`, and `maxSize` where supported; `maxAgeMs` is not a store option.

Age and count retention run on creates and terminal transitions, so a journal without either event may retain an expired record. The age limit reads only the records it deletes. The count limit reads about `maxRecords` rows, so the SQLite and D1 adapters apply it on about 1 in `ceil(maxRecords / 100)` of these writes. Between runs, the terminal record count can exceed `maxRecords` by about 1%. `invocations.prune()` applies every limit immediately.

`maxSize` bounds the live data of the whole database file that holds the journal: its pages minus its free pages. Give the journal its own file, because other tables in the same file count too. A percent is a share of the capacity of the volume that holds the file. It counts only the bytes of this file, not the other files on the volume. The adapter reads the capacity with `statfs` and caches it for 10 minutes. Only a local SQLite file supports `maxSize`. A remote libSQL URL fails when the store is created, and an in-memory database fails on its first operation, both with `AGENT_R0632`.

After a create or a terminal update, the adapter measures the file when the bytes written since the last check reach the larger of 64 KiB and 1% of the budget, or when 60 seconds have passed with writes. When the file is above the budget, it deletes the oldest terminal records in batches until the data fits. It never deletes pending or running records, so a journal of only active records can stay above the budget. A failed size check logs a warning and does not fail the write.

Deletes free pages inside the file. The file shrinks only when it uses `auto_vacuum = INCREMENTAL`. The adapter sets that mode when it creates a new file, and after a size prune it returns up to 1,000 free pages to the file system. A file created before this mode keeps its largest size until a `VACUUM` rebuilds it, but its free pages are reused for new records.


To shrink such a file, run [`vitehub agent invocations compact`](#compact-a-journal-file) once. It rebuilds the file to its live data and sets `auto_vacuum = INCREMENTAL`, so later size prunes shrink it without help.

## Choose how storage failures affect a run

The journal is run history for the Console and the CLI. By default, a slow or unavailable store does not stop a run. Set `enforcement` to select this behavior:

```ts
const invocations = defineAgentInvocations({
  enforcement: 'strict',
  store,
})
```

| `enforcement` | When the store does not confirm a startup operation |
| --- | --- |
| `'best-effort'` (default) | The run starts. The journal retries in the background and logs one warning for the Invocation. |
| `'strict'` | The run does not start. |

Each store operation uses `storeTimeoutMs`, which defaults to 1,000 ms and accepts 1 to 60,000 ms. A timeout, a rejected operation, or a missing result is not a confirmation. Before the Driver starts, a run needs three operations: the execution claim, the `running` state, and the first cancellation check. In best-effort mode, the journal retries the `running` state for up to 60 seconds and reads cancellation requests again every 10 seconds. A failed journal write does not change the result of the run.

Best-effort mode still stops a run when the store answers with a reason to stop:

- The store reports that another execution owner holds the claim. The run fails with `Could not persist the Invocation running state.`
- The store returns a cancellation request. The run moves to `cancelled`.

For a custom `run` Driver, strict mode also requires the cancellation warning state before dispatch. In best-effort mode, the Driver starts without it, and a remote `cancel()` can throw `AGENT_R0974` until the warning write succeeds.

Best-effort history can be missing or stale. A record can stay `pending`, have no `startedAt` time, or have no observations until a retry succeeds. If the store does not recover, the journal can have no record of the run. Keep the product result in your application data. If the store does not answer, two runs with the same run ID can both start, because neither run can see the claim of the other. Use `'strict'` when the journal claim is your only protection against duplicate runs.

Channel replay is always strict. `replayChannel()` and `dispatchChannelItems()` use the journal claim as the duplicate protection for each item, so this option does not apply to them. When a replay sends its claim to a Workflow worker, that worker is also strict. Other Workflow runs follow the configured enforcement.

Live Channel webhook deliveries do not use the journal to prevent duplicates. The webhook route claims each delivery ID with `setIfNotExists()` in the State Adapter, and Chat SDK Channels, such as Telegram, skip a repeated message ID in the same State Adapter. Thus a provider retry does not start a second run in best-effort mode.

## Store invocations in a ViteHub Database

`invocations: 'database'` uses the Database adapter with its defaults. Use the adapter directly to set store options, such as retention:

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

The adapter resolves the named Database for each operation and creates the ViteHub journal tables on first use. It supports `maxAge` and `maxRecords`, not `maxSize`, because the Database also holds other tables. It supports a local SQLite Database, hosted libSQL through Drizzle, and a native Cloudflare D1 binding. Set `database` to another discovered Database name when the default is not the one the Agent should use. The adapter does not open or close the Database, and it does not migrate an existing custom journal. It uses the D1 store contract, including its 1,000,000-byte observation cap and 1,900,000-byte row budget, on SQLite and libSQL too. See [D1 row limits](#store-invocations-in-cloudflare-d1) for truncation and rejected writes.

Use the direct SQLite adapter described above when the journal has its own SQLite or libSQL URL. Use the [`d1` adapter](#store-invocations-in-cloudflare-d1) when the Agent receives a D1 binding directly. The Database adapter is the portable choice when the host configuration already owns Database selection.

## Delete or prune records

Delete or prune terminal records on demand:

```ts
await invocations.delete(invocationId) // 'deleted' | 'not-found' | 'not-terminal'
await invocations.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000, dryRun: true })
await invocations.prune() // applies the store's maxAge, maxRecords, and maxSize now
```

`delete(id)` keeps pending and running records. It returns `'deleted'`, `'not-found'`, or `'not-terminal'`.

`prune()` returns `{ dryRun, ids, size? }`. With `olderThanMs`, it selects completed, failed, and cancelled records last updated before the cutoff. The age must be a non-negative safe integer that produces a cutoff within JavaScript's Date range; invalid ages fail with `AGENT_R0929`. Without `olderThanMs`, it applies the store's configured retention. If the store has `maxSize`, pruning also applies that limit and returns `size: { beforeBytes, afterBytes, budgetBytes }`.

`dryRun: true` lists affected IDs without deleting them. A SQLite size-pruning dry run makes the same deletes in a transaction and rolls it back. D1 dry runs select the affected IDs without deleting records.

The SQLite and D1 adapters and the memory store implement both operations. A custom store must implement `store.delete()` and `store.prune()` to support them. Deletion removes the journal record and its claim. The application owns retention for artifacts that a Capability writes to Blob storage; those artifacts are not keyed by the journal record.

## Rerun a recorded prompt

Read the recorded prompt of a finished record to start it again:

```ts
import { agentInvocationRerunInput } from 'vite-hub/agent'

const record = await invocations.get(invocationId)
const input = record ? agentInvocationRerunInput(record) : undefined
if (input?.available) {
  await runAgent(agent, context, {
    prompt: input.prompt,
    ...(input.invokerProfileId ? { context: { invokerProfileId: input.invokerProfileId } } : {}),
  })
}
```

The result has `available: false` and a `reason` when the record cannot reproduce its input:

| Reason | Input that cannot be reproduced |
| --- | --- |
| `invocation-not-terminal` | The record is pending or running. |
| `input-not-captured` | The prompt was not retained. |
| `replay-metadata-unavailable` | Replay metadata is missing or incomplete. |
| `input-has-invoker` | A direct Actor identity, or a resolver-derived Invoker without a selected Invoker Profile. |
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

The journal keeps `input.prompt` only when `metadataContent` or `content: 'content'` includes it. A selected Invoker Profile is resolved again when the new Invocation starts. `invokerProfileId` holds the profile ID recorded in the start observation, even when an invoker resolver changes the identity. Direct identities, structured input, and call options are not replayed.

This starts a new Invocation from a captured prompt. [Channel history replay](/docs/agents/channels#replay-channel-history) uses the Channel's item identities and strict claims to prevent duplicates.

## Choose what to retain

Use `configuration: 'content'` to retain resolved instructions and tool descriptions/schemas independently of other trace content. The default is `configuration: 'metadata'`. Console journals enable configuration retention for inspection; existing records cannot recover contracts that were not saved. Recorded configuration still uses the journal's observation limits and marks truncated values.

Invocation journals are metadata-only by default. Set `content: 'content'` only when the application must persist prompts, messages, reasoning, tool inputs and outputs, and result text. That opt-in stores sensitive model content in the configured durable store; apply the same access controls, retention policy, and encryption requirements as the source data.

## Redact stored evidence

Use `redact` to rewrite or drop an observation before the store receives it. Use `redactError` to rewrite the error of a failed record:

```ts [server/agents/support.ts]
const invocations = defineAgentInvocations({
  store,
  redact(observation) {
    if (observation.name === 'agent.tool.result') return undefined
    const { 'tool.input': _input, ...attributes } = observation.attributes ?? {}
    return { ...observation, attributes }
  },
  redactError: error => ({ message: error.message, name: error.name }),
})
```

`redact` runs after the content policy and before the journal bounds the observation. It applies to streamed observations, persisted observations, and `appendObservation()` evidence. Return `undefined` to drop evidence; `redactError` can likewise return `undefined` to store no error details while the record remains `failed`. Both hooks are synchronous.

## Inspect retained records

The journal records pending, running, completed, failed, and cancelled states plus bounded invocation metadata and trace observations. Failed records retain bounded `cause` and `AggregateError.errors` trees, common status and code fields, and public ViteHub error details. Use `invocations.list()` for cursor-based summaries, `invocations.get(id)` for a stored record ID, and `invocations.getByRunId(runId, agentName?)` when starting from the source run ID. Always pass the Agent Definition name for a named Definition; the name is part of its durable invocation identity. Trace persistence failures do not change the Agent Invocation result. With `enforcement: 'strict'`, the initial cancellation check must succeed before setup; a rejected, missing, or timed-out read fails startup with `AGENT_R0973`. See [Choose how storage failures affect a run](#choose-how-storage-failures-affect-a-run).

Use `triggeredBy` to filter persisted summaries by the person label recorded in `annotations.triggeredBy`. It matches the trimmed label exactly and composes with Agent, Capability, status, and text filters:

```ts
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

`listTriggeredBy(agentName?)` returns sorted, distinct, non-empty person labels from persisted history, with surrounding whitespace removed. Omit the Agent name to list labels across all Agents. Records without a person label do not match a non-empty `triggeredBy` filter; an empty or whitespace-only filter is ignored. Keep the same filters when following a page cursor. Custom stores can implement `listTriggeredBy()` for a direct lookup; otherwise the Invocations wrapper collects labels by paging through summaries.

## Bound observation storage

Use `observations` to set limits for long traces:

```ts
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

Defaults are 32,768 observations, 65,536 UTF-16 code units of content strings per observation value budget, 16 MiB of serialized observation data, and a 1-second finish drain. Maximum values are 32,768 observations, 1,048,576 code units, 64 MiB, and 60 seconds. The byte limit counts the UTF-8 encoded observations array after privacy filtering. It does not limit provider output, the live trace log, or total process memory. A record keeps its resolved limits when another process resumes it.

When a limit is reached, the journal marks `observationsTruncated` and gives lifecycle outcomes priority over ordinary observations. It can strip large outcome content to retain the outcome within the byte limit. `flushTimeoutMs` controls how long finish waits for queued observations. A longer drain can preserve a long queue of successful writes but cannot make an unavailable store reliable.

Each store operation waits up to `storeTimeoutMs`: one second by default, at most 60 seconds. An operation that takes longer counts as unconfirmed, even if the write lands later, and an unconfirmed running transition stops the Invocation before its Driver starts in `strict` mode. The default `best-effort` mode starts the Driver and retries the write. Raise the limit when the store is far from the runtime, such as a Cloudflare D1 primary in another region:

```ts
const invocations = defineAgentInvocations({
  store: createDatabaseAgentInvocationStore(),
  storeTimeoutMs: 10_000,
})
```

## Inspect and maintain from the CLI

When an application exposes the standard invocation journal route, inspect it without a dashboard:

```sh
vitehub agent invocations list --status running
vitehub agent invocations show INVOCATION_ID
vitehub agent invocations tail INVOCATION_ID
```

The CLI defaults to `http://localhost:5173/api/invocations`. Use `--url` or `VITEHUB_AGENT_INVOCATIONS_URL` for another local endpoint, and `--json` for automation-safe output. `vitehub agent invocations cancel INVOCATION_ID` sends a cancel request into the Nitro runtime of a Vite + Nitro Development Server. A deployed URL, such as `--url https://app.example.com`, uses that deployment's Console for `list`, `show`, `tail`, and `cancel`. See [Cancel an Agent Invocation](/docs/development/cli#cancel-an-agent-invocation) and [Inspect and cancel on a deployed app](/docs/development/cli#inspect-and-cancel-on-a-deployed-app).

Before a rollout, wait until no Invocation is pending or running, so the restart does not interrupt work:

```sh
vitehub agent invocations wait-idle --url https://app.example.com --timeout 30m
```

`wait-idle` reads the same target as `list`. It prints the Invocations that it waits on and exits with status 0 when none is pending or running, or 1 when `--timeout` (default `30m`) passes first. A record that was not updated for `--stale-after` (default `2h`) is reported and does not block, because a crashed process can leave a record running. `--interval` sets the polling interval (default `5s`), `--agent` waits only on one Agent's Invocations, and `--json` prints one `invocations.waiting`, `invocations.idle`, or `invocations.timeout` event per line.
Export Invocations as JSON Lines for offline analysis or evals:

```sh
vitehub agent invocations export --url https://app.example.com --origin webhook --since 7d > invocations.jsonl
```

`export` reads the same target as `list` and prints one line per Invocation, oldest first. Each line is the record without its observations, plus `prompt` and `runId` from `agent.invocation.start`, `final` (the final assistant text), and `deliveries` (each `agent.channel.delivery.effect` with its `channel`, `kind`, `intent`, `content`, and `skipped` reason). `--status`, `--origin`, and `--agent` select records, and `--since` takes an age such as `7d` or an ISO date such as `2026-10-01`. Add `--observations` to include every observation. A field is present only when the journal retained it, so content storage settings decide whether `prompt`, `final`, and delivery content appear.

Delete and prune open a SQLite or libSQL journal directly:

```sh
vitehub agent invocations delete INVOCATION_ID
vitehub agent invocations prune --older-than 30d --dry-run --json
vitehub agent invocations prune --database file:./.data/invocations.db --older-than 12h
vitehub agent invocations prune --database /data/console.sqlite --max-size 30% --dry-run
vitehub agent invocations prune --max-records 1000 --max-size 2GB
```

Without `--database` or `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL`, both commands use the Console journal: `VITEHUB_CONSOLE_DATABASE_URL`, or `.vitehub/data/console.sqlite` in the project root. Set `VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN` for an authenticated libSQL endpoint. Durations accept `ms`, `s`, `m`, `h`, `d`, and `w`. `--older-than` defaults to `30d`. With `--max-size` or `--max-records`, prune applies those limits and the oldest terminal records go first; `--older-than` then applies only when you pass it. `--max-size` accepts the same sizes and percents as `maxSize`, and prints the live data before and after the prune and the budget. Use `--table-prefix` when the store sets `tablePrefix`. The commands refuse a missing database file and never print URL credentials or tokens. For D1, call `invocations.prune()` from a Worker instead.


## Compact a journal file

A journal file that the adapter created before it set `auto_vacuum = INCREMENTAL` keeps its largest size. Its deletes only free pages inside the file. Run `compact` once to rebuild the file with `VACUUM` and set the mode:

```sh
vitehub agent invocations compact --database /data/console.sqlite --dry-run
vitehub agent invocations compact --database /data/console.sqlite --json
```

`compact` measures the file, its WAL, the page count, the free pages, and the `auto_vacuum` mode. Then it runs `PRAGMA auto_vacuum = INCREMENTAL`, `VACUUM`, and `PRAGMA wal_checkpoint(TRUNCATE)`, and prints the size before and after, the reclaimed bytes, and the new mode. `--dry-run` prints the measurements, the projected size, and the free space check, and changes nothing. It exits with 1 when compact would refuse to run. Prune first, so that the rebuilt file holds only the records that you keep.

- Only a local SQLite file can be compacted. A remote libSQL URL and an in-memory database fail with `AGENT_R0931`.
- `VACUUM` writes a copy of the live data to the SQLite temporary directory, then a journal or WAL of about the same size next to the database. Compact refuses to run when a volume has less free space than 1.1 times the live data for each of these files, plus the current WAL. When both are on the same volume, it needs both. Set `SQLITE_TMPDIR` to put the temporary copy on another volume.
- `VACUUM` needs the write lock for its full duration, and the server waits to write until it finishes. Stop the server or run compact during a quiet window. When another process holds the lock for more than 5 seconds, compact fails and changes nothing.

`list`, `show`, and `tail` can also read a SQLite journal file directly, without the app or a Console session. This works inside a running container, where the journal is on local disk:

```sh
vitehub agent invocations list --database /data/console.sqlite --status running
vitehub agent invocations show INVOCATION_ID --database /data/console.sqlite --json
```

The command opens the file read-only with `node:sqlite` and does not migrate or write it, so it is safe while the app writes the same file. It reads observations from the record and from the table where running records keep appended observations. It accepts a path or a `file:` URL and refuses a remote libSQL URL; use `--url` for a deployed app. `--table-prefix` applies. `cancel` still needs the running app. A runtime without `node:sqlite` reports that and exits with status 1.

## Host recovery limits

Configured journals also retain failures and cancellation during Workflow preparation, before provider dispatch. Fresh manual starts get distinct invocation IDs. Durable Channel deliveries keep their delivery run ID across preparation attempts.

Cloudflare and OpenWorkflow create the journal after durable recovery dispatch and reconcile failures after the generated Agent module loads but before the Agent handler starts. If that module cannot be evaluated, use Workflow inspection because the Agent-owned invocation store is unavailable.

Vercel Agent Definitions currently run through the inline Workflow adapter because arbitrary Agent handlers cannot be embedded in Vercel's deterministic native Workflow bundle. An accepted run starts its journal in that Agent worker, and ViteHub keeps bounded journal recovery work inside the active execution. Vercel does not expose a lifecycle hook that can guarantee arbitrary Agent recovery after that execution settles, so treat its journal as best-effort and use Workflow inspection as the authority for accepted runs. A synchronous Vercel start rejection is still recorded as a failed Agent Invocation. The run inspection metadata reports `mode: "inline"` for this path.

## Store invocations in Cloudflare D1

Use the D1 adapter when the application already has a D1 database. The binding can be resolved for each operation, so an Agent Definition does not need access to request bindings at module load:

```ts [server/invocations.ts]
import { env } from 'cloudflare:workers'
import { createD1AgentInvocationStore } from 'vite-hub/agent/invocations/d1'
import { defineAgentInvocations } from 'vite-hub/agent/server'

export const invocations = defineAgentInvocations({
  store: createD1AgentInvocationStore({
    database: () => env.DB,
    maxAge: '30d',
    maxRecords: 10_000,
  }),
})
```

The store creates its table and indexes on first use of each binding in a Worker isolate. The statements use `CREATE ... IF NOT EXISTS`, so concurrent isolates and existing tables are safe. A failed creation is retried on the next operation.

To manage the schema with your own migrations, set `migrate: false` and apply `d1AgentInvocationSchema()` before the first request:

```ts [scripts/invocation-schema.ts]
import { d1AgentInvocationSchema } from '@vite-hub/agent/invocations/d1'

console.log(d1AgentInvocationSchema().join(';\n') + ';')
```

`tablePrefix` defaults to `vitehub_agent_`; pass the same prefix to the schema function and store to use another table name. The table is outside your Drizzle schema, so `vitehub db generate` does not create or drop it. These statements create a new ViteHub-owned schema. They do not convert a custom application journal or the libSQL adapter's tables. Keep an existing journal until its records have been migrated explicitly.

D1 batches make creation and retention atomic. Conditional updates retry when another Worker changes the record, so concurrent observations are preserved. Claims use the database clock and fence updates after ownership changes. After 32 concurrent write conflicts, an update rejects instead of overwriting another writer. The store uses the same terminal-record retention defaults and observation deduplication as the libSQL store. It rejects `maxSize` with `AGENT_R0911`, because D1 reports the size of the whole database, not of the journal. Use `maxAge` and `maxRecords`. It supports Agent, Capability, triggering-person, status, and text filters, lists recorded person labels with `listTriggeredBy()`, and reads summaries without observation payloads. Use `get(id, { observationNames })` to select observation payloads by name.

[D1 limits a row to 2 MB](https://developers.cloudflare.com/d1/platform/limits/). The adapter caps retained observations at 1,000,000 UTF-8 bytes, even when the journal requests a larger limit. Each record exposes this resolved limit in `observationLimits`. It also checks the full row, including repeated summary and search text. If that row is too large, it removes ordinary observations and marks `observationsTruncated` while keeping lifecycle fields and previously appended evidence. If the remaining row still cannot fit, the update rejects before a database write. Use another store when the complete long trace must be retained.

This direct adapter accepts a D1 binding. Use the [Database adapter](#store-invocations-in-a-vitehub-database) for ViteHub-managed SQLite or libSQL. The database binding stays owned by the host; the store does not open or close it. Use [`redact`](#redact-stored-evidence) to remove sensitive values before they reach D1. Route authorization remains application policy.

On the Cloudflare preset, the Console journal uses this store with the D1 Database binding when no Agent Definition configures `invocations`. See [Cloudflare journal](/docs/development/console#know-what-the-console-stores). Local D1 tests cover the SQL and concurrency contract; they do not measure production D1 limits or latency.

## Append delivery evidence

Use `appendObservation()` when a host must record an external delivery before or after an Invocation finishes:

```ts
const record = await invocations.appendObservation(invocationId, {
  name: 'report.delivered',
  type: 'capability',
  attributes: { 'report.id': reportId },
}, { id: `report-delivered:${reportId}` })
```

The observation ID is required, must be at most 512 characters, and makes retries idempotent within that Invocation. The store assigns the sequence atomically.

This operation does not change Invocation status or its active lease, and it applies the configured content policy. The result is the stored record, or `undefined` when the Invocation does not exist. A failed write or full observation capacity throws. If `redact` drops the observation or fails, the method returns the existing record without appending. A caller that requires delivery evidence must confirm its observation ID in the returned record. 

An append uses the observation limits saved with the record, including after restart. It rejects before changing the record if count, byte, or provider row capacity would remove evidence. Accepted appends remain intact under later trace pressure until the whole Invocation is removed by retention. Keep the same observation ID when retrying a write whose result is unknown. Custom stores must implement the `appendObservation` field on `AgentInvocationStoreUpdateInput`; a store that ignores it fails explicitly.

## Cancel an invocation

Call `invocations.cancel(id)` to cancel a pending or running Invocation. The journal records `cancelRequestedAt` first, so every process that shares the store can read the request.

```ts
const result = await invocations.cancel(id)
if (result.notEnforcedBy) console.warn(`Cancel requested, not enforced by ${result.notEnforcedBy}`)
```

| `outcome` | Meaning |
| --- | --- |
| `requested` | The request was recorded or sent locally. `delivery: 'local'` means a run in this process received an aborted signal. `delivery: 'journal'` means the store retained the request for a current or future execution owner. Neither confirms that execution stopped. A missing journal record still returns `requested` with local delivery if a local run received the request. |
| `terminal` | The journal has a final state in `status`. A stale Driver may still be active. Local abort delivery and durable or local `notEnforcedBy` warnings remain in the result. A durable warning describes the Driver enforcement contract; it does not prove execution is still active. |
| `not-found` | The journal has no Invocation with this id and no local run received the request. |
| `unavailable` | The store did not keep the request and no run in this process holds the Invocation. |

Before setup, active runs check for a journal cancellation request. In strict mode, a rejected or missing read, or a check that exceeds `storeTimeoutMs`, fails startup with `AGENT_R0973`. In best-effort mode, the run starts and reads the request again at the next poll. A cancellation request that the store returns always stops startup. After startup, active runs read journal requests every 10 seconds, including after a lost lease stops claim renewal. A crashed owner or expired lease does not prove that a Driver stopped. An orphaned record remains pending or running until execution recovery observes its request; cancellation does not recover orphaned work or promise a completion deadline. Repeating the request does not change that state. Read the final journal status to confirm cancellation.

The Development Server command `vitehub agent invocations cancel <id>` checks all registered journals before cancellation. If distinct journals contain the same ID, it rejects the request with HTTP `409` without changing either record. Call the intended Agent's `invocations.cancel(id)` to select its journal. Registry entries that share one journal are checked once. If any journal lookup fails, the request fails before cancellation because uniqueness cannot be verified.

If the durable request write fails, cancellation still aborts a local run and propagates the storage error. This does not create a durable request for other processes.

A local abort can signal a stale execution owner after lease replacement. Cancellation results also retain the current journal owner's durable Driver warning. The pending marker includes `cancelWarningOwnerId`, which identifies its execution owner. A local handle for another owner must verify that marker before reporting success. Custom stores preserve both pending fields; clearing `cancelWarningPending` also clears its owner ID.

An observed cancel request aborts the Invocation abort signal. That signal stops the Driver capacity wait, the Driver run, tool calls, queued webhook executions, and scheduled turns. A webhook failure caused by cancellation completes its delivery without a retry. An unrelated failure still retries, even if the Invocation has a historical cancellation request. The record then moves to `cancelled` through the usual `agent.invocation.cancelled` event.

| Driver | Cancel |
| --- | --- |
| `model` | Enforced. The AI SDK request receives the abort signal. |
| `provider` (`claude-code`, `codex`) | Enforced. The provider session receives the abort signal. |
| `run` | Not enforced. The handler receives `context.input.abortSignal` and can stop on its own. ViteHub cannot stop it. |

Cancellation before Driver dispatch stops startup without a `notEnforcedBy` warning. New custom Driver journals persist `cancelWarningPending` at creation until dispatch can be verified. A reused record must confirm this pending state before dispatch if its running update fails. After dispatch, they retry the warning write for up to one minute. A cancellation caller in another process waits up to five seconds for a pending state to become a durable warning or a terminal record. If it cannot verify that state, `cancel()` throws `AGENT_R0974`; the cancellation request is already recorded. Inspect the journal again to confirm the result. Terminal writes preserve `cancelNotEnforcedBy` even if an earlier warning write failed. Custom stores must preserve `cancelWarningPending` on creation and update and clear it when `applyAgentInvocationStoreUpdate()` receives `false`. When a started Driver does not enforce cancel, the result has `notEnforcedBy`, and the record keeps `cancelNotEnforcedBy` and `cancelRequestedAt`. The record stays `running` until the Driver returns. ViteHub does not report the Invocation as cancelled.

## Recover interrupted Invocations

For a process-owned store, `createProcessAgentInvocations` from `vite-hub/agent/runtime/process` runs interrupted-invocation recovery before returning the journal. Pass the normal `defineAgentInvocations` options and a `recovery` object with a `recover(invocation)` ownership predicate. Use `recover: () => true` only when the database belongs exclusively to that service. Recovery failure rejects startup.

With a libSQL Agent state provider, a persistent Nitro server runs this recovery at startup for each Agent journal, before it resumes queued webhook deliveries. It fails the Agent's pending or running invocations that started before the process, except invocations that a persisted queued delivery runs again under the same run ID. Agents with a durable Workflow runtime are skipped. A recovery failure is logged and the queue still resumes.

## Next steps

Use [Observability](/docs/agents/observability) to export lifecycle events and [Evals](/docs/agents/evals) to check behavior. The [Console](/docs/development/console) reads the configured journal; its authorization remains application policy.
