---
title: Move the Console from earlier releases
description: Replace removed Console options, such as console.pill, console.mcpClient, and console.databaseUrl, and remove the Console data that apps kept.
navigation.title: Move from earlier releases
navigation.order: 41
navigation.group: Reference
icon: i-lucide-arrow-right-left
---

A build that sets a removed `console` option fails with `VITE_HUB_B0020`, and the message names the fix.

## Run the codemods

`vitehub migrate` makes the config and code changes on this page that it can make safely:

```bash [Terminal]
pnpm vitehub migrate --dry-run
pnpm vitehub migrate
```

- `vitehub-options` removes `console.pill`, `mcpClient`, `embed`, `mcp`, `origins`, `signInPage` and `auth: 'token'`. When no option stays, it writes `console: true` (`console: {}` in a Nuxt environment override). It moves `console.databaseUrl`, `observations` and `retention` to `agent: { invocations }` only when it can preserve the effective journal. In Nuxt apps with layers, check the merged options and move these settings by hand.
- `console-out-of-app` removes the `via === 'page'` branch of `console.authorize` and the `ConsolePageAuthorizeContext` import.
- `runtime-contracts` reports imports of `vite-hub/console/mcp-client`.

The report lists what you must change by hand, such as `console.auth: 'app'`, Console Auth, and each env or Wrangler line that sets `VITEHUB_CONSOLE_MCP_KEY`. The codemods do not change a database. Run the SQL in [Remove the Site access data](#remove-the-site-access-data) and [Drop the usage tables](#drop-the-usage-tables) yourself. See [Upgrade ViteHub](/docs/codemods/upgrade-vitehub).

## Move from auth: "app" or Console Auth

Apps no longer sign people in to the Console. `console: { auth: 'app' }`, Console Auth (`auth: { ... }` with a server file, GitHub or Cloudflare Access), `auth: 'token'`, `console.origins`, `console.mcp`, `console.signInPage` and `console.embed` are removed, and so are `/_vitehub/mcp`, `/_vitehub/sign-in`, `/_vitehub/api/auth/**`, `/_vitehub/env/manage` and the Console's OAuth discovery.

1. Remove `auth`, `origins`, `mcp` and `signInPage` from `console`, or set `console: true`.
2. Move checks of the person to [`console.authorize`](/docs/console/access#write-authorize), which gets the signed `user` and their `team` and role.
3. Remove `consoleMcpOAuth()` from `server/auth.ts`. Keep `mcpOAuth()` if the app serves its [own MCP server](/docs/mcp).
4. [Link the app](/docs/console/get-started#link-a-deployed-app), set the `VITEHUB_CONSOLE_KEY_<NAME>` line, and invite the app's Console users to your team.
   If Cloudflare Access protected the app’s Console, delete that Access application or add a Bypass policy for `/_vitehub/rpc`. Otherwise Access redirects Console calls to sign-in and the Console answers `CONSOLE_FORWARD_REDIRECT`.
5. For the CLI, replace `VITEHUB_CONSOLE_AUTHORIZATION`, `VITEHUB_CONSOLE_COOKIE` and `CF_ACCESS_CLIENT_ID` with a [`VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`](/docs/console/signed-requests) from `vitehub secret console-key`.
6. Connect agents to the [ViteHub MCP](/docs/console/mcp) instead of `/_vitehub/mcp`.

App Auth access routes such as `/_vitehub/**` or `/**` no longer cover `POST /_vitehub/rpc` and `GET /_vitehub/site`, because a signed call has no app session, a Console token carries its own proof, and the route checks its own access. An app route file on the same path, such as `server/routes/_vitehub/rpc.post.ts`, fails the build.

Live Content editing, the preview pane of a Content page, Env management and the Connections connect flow needed the app session, so they are not in the Console. **Preview** opens the page in a new tab of the app instead, see [Impersonation and Content preview](/docs/console/site-access#impersonation-and-content-preview).

## Remove the Console link check

Apps do not add the Console link to their pages. The Comments pill loads its **Console** segment from the ViteHub Console, and the Console checks the person and the team. `console.pill` is removed, and `console.authorize` no longer gets `via: 'page'`. The `ConsolePageAuthorizeContext` type is removed too.

```diff [server/console-authorize.ts]
 import { defineConsoleAuthorize } from 'vite-hub/console/auth'

 export default defineConsoleAuthorize(({ via, user }) => {
-  if (via === 'page') return user?.role === 'admin'
   return true
 })
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```diff [nuxt.config.ts]
 export default defineNuxtConfig({
   modules: ['vite-hub/nuxt'],
   vitehub: {
-    console: { pill: false },
+    console: true,
   },
 })
```
:::
:::tabs-item{label="Nitro"}
```diff [vite.config.ts]
 export default defineConfig({
   plugins: [
     vitehub({
-      console: { pill: false },
+      console: true,
     }),
     nitro(),
   ],
 })
```
:::
:::tabs-item{label="Vite"}
```diff [vite.config.ts]
 export default defineConfig({
   plugins: [
     vitehub({
-      console: { pill: false },
+      console: true,
     }),
   ],
 })
```
:::
::

An app without Comments that the Console links gets the [Hosted Comments](/docs/comments/configure#add-hosted-comments) pill, and `/_vitehub` sends the browser back to the page with `?vitehub`. With `comments: false`, `/_vitehub` opens the app in the Console at `https://console.vitehub.dev`.

## Remove the Site access data

Site access now lives in the ViteHub Console. New Site access sign-ins use a token signed by the Console and do not create an app Auth user or session. Earlier releases left data in the app Database:

- the `vitehub_console_site` table, for Site access links and sessions,
- with app Auth, a guest user for each guest, with the email `guest-<uuid>@guests.invalid`, its sessions, and an `account` row with `provider_id = 'vitehub-site-guest'`,
- with app Auth, the `console` and `comments-*` roles that Site access added to the `user.role` of members.

The SQL finds guests by the `vitehub-site-guest` account, not by the email, so it does not delete other users with such an email. Run it once on each app Database. It is safe to run again, and a statement that finds nothing changes nothing. Without app Auth, run only the first statement.

The SQL deletes guest sessions, but it does not revoke existing member sessions. Earlier Site access sign-ins issued ordinary Better Auth sessions with no Site access marker. Those sessions can still satisfy an app's sign-in check after the SQL removes the Site access roles. If those members must lose app access, identify the affected accounts before cleanup and revoke their sessions under [Auth → Users](/docs/auth/console#pages). Revoke all sessions for each affected account if you cannot identify individual sessions; this also signs out ordinary app logins for those users.

::tabs
:::tabs-item{label="SQLite and D1"}
```sql [site-access-cleanup.sql]
DROP TABLE IF EXISTS "vitehub_console_site";
CREATE TABLE IF NOT EXISTS "vitehub_site_guest_cleanup" ("id" PRIMARY KEY);
INSERT OR IGNORE INTO "vitehub_site_guest_cleanup" SELECT "user_id" FROM "account" WHERE "provider_id" = 'vitehub-site-guest';
DELETE FROM "session" WHERE "user_id" IN (SELECT "id" FROM "vitehub_site_guest_cleanup");
DELETE FROM "account" WHERE "user_id" IN (SELECT "id" FROM "vitehub_site_guest_cleanup");
DELETE FROM "user" WHERE "id" IN (SELECT "id" FROM "vitehub_site_guest_cleanup");
DROP TABLE "vitehub_site_guest_cleanup";
WITH RECURSIVE "piece"("user_id", "n", "raw", "rest") AS (
  SELECT "id", 0, NULL, "role" || ',' FROM "user" WHERE "role" IS NOT NULL
  UNION ALL
  SELECT "user_id", "n" + 1, substr("rest", 1, instr("rest", ',') - 1), substr("rest", instr("rest", ',') + 1) FROM "piece" WHERE "rest" <> ''
), "token"("user_id", "n", "raw", "name") AS (
  SELECT "user_id", "n", "raw", trim("raw", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) FROM "piece" WHERE "raw" IS NOT NULL
)
UPDATE "user" SET "role" = (
  SELECT group_concat("raw", ',') FROM (
    SELECT "raw" FROM "token" WHERE "user_id" = "user"."id" AND "name" <> '' AND "name" NOT IN ('console', 'comments-read', 'comments-write', 'comments-resolve', 'comments-delete') ORDER BY "n"
  )
)
WHERE "id" IN (SELECT "user_id" FROM "token" WHERE "name" IN ('console', 'comments-read', 'comments-write', 'comments-resolve', 'comments-delete'));
```
:::

:::tabs-item{label="Postgres"}
```sql [site-access-cleanup.sql]
DROP TABLE IF EXISTS "vitehub_console_site";
DELETE FROM "session" WHERE "user_id" IN (SELECT "user_id" FROM "account" WHERE "provider_id" = 'vitehub-site-guest');
WITH "guest_account" AS (
  DELETE FROM "account" WHERE "user_id" IN (SELECT "user_id" FROM "account" WHERE "provider_id" = 'vitehub-site-guest') RETURNING "user_id"
)
DELETE FROM "user" WHERE "id" IN (SELECT "user_id" FROM "guest_account");
UPDATE "user" SET "role" = NULLIF(array_to_string(array(
  SELECT "raw" FROM unnest(string_to_array("role", ',')) WITH ORDINALITY AS "token"("raw", "n"), btrim("raw", E'\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') AS "name"
  WHERE "name" <> '' AND "name" NOT IN ('console', 'comments-read', 'comments-write', 'comments-resolve', 'comments-delete') ORDER BY "n"
), ','), '')
WHERE EXISTS (
  SELECT 1 FROM unnest(string_to_array("role", ',')) AS "token"("raw"), btrim("raw", E'\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') AS "name"
  WHERE "name" IN ('console', 'comments-read', 'comments-write', 'comments-resolve', 'comments-delete')
);
```
:::
::

Save the SQL for your database in a file, and run it with [`vitehub database sql`](/docs/database/configure#run-sql-and-drop-tables). Add `--database <name>` when Auth uses a Database that is not the default one:

```bash [Terminal]
cat site-access-cleanup.sql | pnpm vitehub database sql
cat site-access-cleanup.sql | pnpm vitehub database sql --remote --stage production
```

The SQL keeps the other roles of a member, such as `admin` or `user`, as they are written, and sets `role` to `NULL` when no role stays. A member that Site access made from an email keeps the user row, without the Site access roles. Delete these users in the Auth section of the Console if you do not need them. D1 does not accept `BEGIN` and `COMMIT`, so the SQL has no transaction. On SQLite and D1 it keeps the guest ids in the `vitehub_site_guest_cleanup` table until the guests are deleted. `vitehub database sql` stops at the first error, and you can run the SQL again after you fix it.

## Drop the usage tables

The Console kept an index of Agent usage next to the Agent Invocation journal. [The usage-index removal (#5409)](https://github.com/vite-hub/vitehub/pull/5409) switches those builds to reading usage directly from the journal. The old triggers still run on journal changes until you drop them.

Run this SQL only after every running instance that uses the journal runs a build containing the usage-index removal. Upgrading to a build that contains only the Console migration codemods is not enough. A build that still uses the index can fail or recreate the tables after the drop.

```sql [drop-console-usage.sql]
DROP TRIGGER IF EXISTS "vitehub_console_usage_v2_insert";
DROP TRIGGER IF EXISTS "vitehub_console_usage_v2_update";
DROP TRIGGER IF EXISTS "vitehub_console_usage_v2_delete";
DROP TABLE IF EXISTS "vitehub_console_usage_v2";
DROP TABLE IF EXISTS "vitehub_console_usage_v2_dirty";
```

The index was only on SQLite, libSQL and D1 journals, so a Postgres journal needs no change. Dropping a table also drops its indexes. Run the SQL on the database of the journal:

| Journal | Command |
| --- | --- |
| The local file, `.vitehub/data/agent-invocations.sqlite`, or `.vitehub/data/console.sqlite` of earlier releases | `sqlite3 .vitehub/data/agent-invocations.sqlite < drop-console-usage.sql` |
| `agent: { invocations: 'database' }`, or D1 on Cloudflare | `cat drop-console-usage.sql \| pnpm vitehub database sql`. Add `--remote --stage production` for the deployed database |
| A libSQL `databaseUrl` | Run the file with the libSQL shell of your provider, such as `turso db shell <name> < drop-console-usage.sql` |

## Move from the MCP of the app

The per-app Console MCP at `/_vitehub/mcp`, with OAuth from `consoleMcpOAuth()`, is removed. Connect the agent to `https://console.vitehub.dev/mcp/account`, link the app in the Console, and remove `consoleMcpOAuth()` and `console.mcp`.

## Move from the app MCP client

`console.mcpClient` is removed, and so are `vite-hub/console/mcp-client`, `VITEHUB_CONSOLE_MCP_KEY` and the `/_vitehub/mcp-client/callback` page. The [MCP client section](/docs/console/mcp-client) now runs on the ViteHub Console server and keeps its connections there.

1. Remove `mcpClient` from `console`.
2. Remove `VITEHUB_CONSOLE_MCP_KEY` from the app. Its KV entries below `vitehub:console:mcp-client:` are no longer read, so you can delete them.
3. Remove `@modelcontextprotocol/sdk` from the app if nothing else uses it.
4. Connect again in the Console. When an MCP server needs a fixed OAuth callback, register `<console origin>/mcp-client/callback`, such as `https://console.vitehub.dev/mcp-client/callback`.

Apps also stop serving the ViteHub skill at `/_vitehub/.well-known/skills`. Install it [from the Console](/docs/getting-started/ai-resources/agent-instructions-skills#install-from-the-console).

## Move from one-time links

Impersonation and Content preview no longer use one-time links. `GET /_vitehub/rpc?ticket=` is removed, and the app no longer keeps tickets in Better Auth's verification table or in its KV store. The Console now signs an `impersonate` or `preview` token for 60 seconds, and the app checks it at `/_vitehub/site`, as it checks [Site access](/docs/console/site-access#impersonation-and-content-preview). An app without Comments serves `/_vitehub/site` too.

1. Update the Console and the app together. An older Console asks the app for a ticket link, and the app now answers `auth.impersonate`, `auth.stop-impersonating` and `documents.preview` with `{ path }`.
2. Move an app route on `/_vitehub/site`, if you have one, to another path. The build now fails with `VITE_HUB_R0040` on it in every app with `console`.
3. The codes `CONSOLE_TICKET_INVALID`, `CONSOLE_TICKET_MISMATCH`, `CONSOLE_TICKET_NO_PERSON` and `CONSOLE_TICKET_STORE_MISSING` are removed. A refused token gets `CONSOLE_SITE_TOKEN_REFUSED`. An impersonation in a browser signed in to the app as another person gets `CONSOLE_SITE_ACCOUNT_MISMATCH`.

## Use a self-hosted Console

Apps link to `https://console.vitehub.dev`. Set [`console.url`](/docs/console/get-started#self-host-the-console) to send `/_vitehub`, Console links, the Site access sign-in and the Comments pill to your own Console.

## Move the Agent journal options

`console.databaseUrl`, `console.observations` and `console.retention` now fail the build with `VITE_HUB_B0020`, and `VITEHUB_CONSOLE_DATABASE_URL` fails the server with `AGENT_R1032`. Set `agent: { invocations: { databaseUrl, observations, retention } }` and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` instead. The old journal lived at `.vitehub/data/console.sqlite`: to keep its records, set `databaseUrl` to that file, or pass it to [`vitehub agent invocations`](/docs/agents/invocation-storage#inspect-and-maintain-from-the-cli) with `--database`.
