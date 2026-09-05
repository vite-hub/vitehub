# Session history and usage

The Console Usage page lists completed, failed, and cancelled sessions, newest first. Open a session title to return to its existing conversation and inspector. Active sessions stay in the Agents panel.

Each history row uses the same Agent Invocation ID as the Console session panel. A transport thread ID can contain separate executions, so history does not merge invocations by thread or title. Tokens and cost come from the recorded usage for that invocation, including its model calls.

Filter by date, Agent, status, or session title and ID. The search also matches Agent names. Filters stay in the URL, so returning from a session restores the selected history view. Sessions remain visible when usage is missing. An unavailable value is not zero; partial totals are labeled `recorded`.

Expand **Usage breakdown** for charts, model totals, averages, and the most expensive invocations. **Provider status** contains readiness and subscription quota. Readiness checks inspect the configured provider account without sending a model prompt. A successful check is evidence at its checked time; it does not guarantee the next reply.

All history filters apply to totals, average cost, most expensive invocations, and the paginated history table. Completed, failed, and cancelled invocations contribute any cost they recorded. Subscription quota is separate from USD cost. Providers without cost evidence keep token and session history; monetary panels appear only when cost is configured or has been recorded.

Averages divide the recorded decimal cost by the number of priced invocations. Unknown cost is not zero. A recorded zero is included in coverage and averages. Model averages combine calls using the same model within an invocation so auxiliary calls contribute once to that invocation/model row. Estimated amounts carry a `~` prefix.

## Persistence and API

`GET /api/_vitehub/console/usage?window=30d&agent=bot&status=failed&search=release` uses the same authenticated Console access policy as session inspection. The Console client carries this operation over its existing RPC connection. The response contains `sessions`, `sessionCount`, time buckets, totals, Agent/model groups, and the ten most expensive invocations. Each session includes its invocation ID, Agent, recorded title when available, status, last activity, models, and usage totals. Up to fifty session rows are returned per page. Pass the returned opaque `cursor` unchanged to retrieve the next page with the same filters. The cursor fixes the first page’s date cutoff, so newly completed sessions appear after Refresh resets pagination. Totals cover all matching sessions within that cutoff. Deletion and historical backfill can still change rows and totals; the cursor does not hold a database snapshot. Invalid cursors or changed filters return HTTP 400.

Supported windows are `24h`, `7d`, `30d`, and `90d`. Optional `status` accepts `completed`, `failed`, or `cancelled`. Search is a case-insensitive literal match against title, ID, and Agent name. Date filtering uses completion time, falling back to last update or creation time when completion time is absent.

The standard Console SQLite database maintains a rebuildable usage projection. Change triggers enqueue changed invocation IDs. Historical backfill reads only the final usage observation inside SQLite, then stores compact usage summaries. Aggregates use indexed date/agent queries; decimal cost groups are summed with bigint arithmetic so SQLite floating-point conversion cannot change a monetary total. Expensive-invocation ordering compares normalized decimal parts.

Backfill runs in bounded batches. `projection.complete: false` and `partial: true` mean totals are still incomplete. Refresh after backfill finishes. This projection does not change invocation retention or hold transcripts. Deleting an invocation removes its projection. A process restart resumes pending work. The version 2 history projection has separate tables and triggers, so an older process can keep using its version 1 projection during a rolling update. A custom invocation store uses its existing paginated read interface instead of the Console SQLite projection.

The native SQLite regression fixture is `packages/vite-hub/test/console-usage-index.test.ts`. It exercises 100,001 invocations, exact decimal totals, missing cost, failed and cancelled runs, auxiliary calls, pagination, replay, updates, and deletion without invoking a model.

## Console image attachments

With Blob storage configured, the Console composer accepts PNG, JPEG, WebP, and GIF images. Each message supports up to ten images and 10 MiB combined. You can send an image with or without text. The server stores the bytes in Blob storage and gives the Driver a reference with a download callback. Invocation journals retain image metadata and URLs without serializing callbacks or image bytes. Use durable Blob storage and content-enabled Invocation storage to retain the images and their message references across restarts.

The Console renders image references in input and output messages. An Agent can publish a generated image with the Blob Capability and include its URL in Markdown. The Blob Capability also rewrites artifact links in the final response.
