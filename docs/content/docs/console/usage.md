# Usage and provider status

The Console Usage page combines provider readiness, subscription quota, recorded usage, and invocation history. Readiness checks inspect the configured provider account without sending a model prompt. A successful check is evidence at its checked time; it does not guarantee the next reply.

The date and agent filters apply to totals, average cost, most expensive invocations, and the paginated invocation table. Completed, failed, and cancelled invocations contribute any cost they recorded. Subscription quota is separate from USD cost. Providers without cost evidence keep token and invocation history; monetary panels appear only when cost is configured or has been recorded.

Averages divide the recorded decimal cost by the number of priced invocations. Unknown cost is not zero. A recorded zero is included in coverage and averages. Model averages combine calls using the same model within an invocation so auxiliary calls contribute once to that invocation/model row. Estimated amounts carry a `~` prefix.

## Persistence and API

`GET /api/_vitehub/console/usage?window=30d&agent=bot` uses the same authenticated Console access policy as session inspection. It returns time buckets, totals, agent/model groups, the ten most expensive invocations, and up to fifty invocation rows. Pass the returned `cursor` to retrieve the next page. Supported windows are `24h`, `7d`, `30d`, and `90d`.

The standard Console SQLite database maintains a rebuildable usage projection. Change triggers enqueue changed invocation IDs. Historical backfill reads only the final usage observation inside SQLite, then stores compact usage summaries. Aggregates use indexed date/agent queries; decimal cost groups are summed with bigint arithmetic so SQLite floating-point conversion cannot change a monetary total. Expensive-invocation ordering compares normalized decimal parts.

Backfill runs in bounded batches. `projection.complete: false` and `partial: true` mean totals are still incomplete. Refresh after backfill finishes. This projection does not change invocation retention or hold transcripts. Deleting an invocation removes its projection. A process restart resumes pending work. A custom invocation store uses its existing paginated read interface instead of the Console SQLite projection.

The native SQLite regression fixture is `packages/vite-hub/test/console-usage-index.test.ts`. It exercises 100,001 invocations, exact decimal totals, missing cost, failed and cancelled runs, auxiliary calls, pagination, replay, updates, and deletion without invoking a model.
