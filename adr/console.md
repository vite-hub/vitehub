# @vite-hub/console decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## The Console serves the public page tools route without Comments

`viteHubPageSessionHandler` in `packages/vite-hub/src/console/runtime/server/page-tools-route.ts`.

**Context:** An app can use the Console without Comments. The page tools listing must still be available, including to anonymous visitors.

**Decision:** The Console registers the shared handler under a page tools name, not an auth session name. The listing shows tools available to the visitor; each tool checks access again on its own routes.

**Consequences:** Vite Doctor treats paths with words such as `session` as candidates for auth routes. Keep the public page tools route name distinct from those paths.

## Passkey accounts carry a reserved placeholder email that GitHub linking replaces

`defineAuth account.accountLinking`, `databaseHooks.account.create/update`, `passkeySignUp.afterVerification`, `adoptGitHubEmail`, `mayComment` in `packages/console/server/auth.ts`, `packages/console/src/accounts.ts`, `packages/console/src/commenters.ts`.

**Context:** A passkey sign-up creates a user with email `<id>@passkey.invalid`. Better Auth keeps the local email when an account links, and refuses a link with a different email unless allowed.

**Decision:** accountLinking.allowDifferentEmails is true only so a passkey account can link GitHub. adoptGitHubEmail runs on both account create and update hooks, replaces only the passkey.invalid placeholder with the verified primary GitHub email when no other user has it, and logs instead of throwing because the link is already saved. passkeySignUp.afterVerification returns {} when the user exists, because Better Auth resolved the user from the session (adding a passkey to an existing account). Placeholder emails never count as a real person (mayComment refuses them).

**Consequences:** Turning off allowDifferentEmails breaks GitHub linking for passkey accounts. Throwing from adoptGitHubEmail would fail a link that is already stored. Dropping the update hook stops retrying the email on reconnect. Treating the placeholder as a real email lets any passkey account match invitations or the commenters list.

## The CLI device flow never yields a Better Auth session

`consoleDeviceDisabledPaths`, `cliGrant`, `consoleCliDeviceFlow (rateLimit, consoleCliApprove)` in `packages/console/server/auth.ts`, `packages/console/src/device.ts`.

**Context:** `vitehub login` uses the RFC 8628 device flow of Better Auth, but the Console wants the CLI to hold a team-scoped API key, not a session.

**Decision:** Better Auth's /device/token is disabled (refuses every code); /cli/token gives an API key after /cli/approve with a team. Only client_id vitehub-cli may start a flow. /cli/token is limited to 30 per minute because a CLI polls at most 12 per minute (more means a client that ignores slow_down). GET /api/auth/device claims the code for the first signed-in person who opens it, and /cli/approve refuses any other person.

**Consequences:** Re-enabling /device/token would hand the CLI a full browser session. Lowering the /cli/token limit below the polling rate breaks normal logins. Removing the userId check on approve lets another signed-in person approve a stolen code.

## The Console forward signs exact bytes and isolates the project from the Console origin

`forwardProjectRequest`, `requestHeaders`, `responseHeaders`, `redirectProblem`, `signedProjectCall` in `packages/console/src/forward.ts`, `packages/console/server/utils/console.ts`.

**Context:** The browser never holds the link's private key: the Console server signs each call and sends it to the project, so the project needs no CORS.

**Decision:** Only accept/content-type/if-none-match/x-vitehub-console go upstream (no cookies, Origin, Authorization); only cache-control/etag/last-modified/www-authenticate come back (no Set-Cookie; fetch already decoded the body so encoding/length headers stay out). The path check runs on the URL after the parser resolved `..` and encoded forms. The signature covers the exact body bytes the project receives (birpc's body is signed as written). Redirects are not followed (redirect: manual) because they could carry the signed request elsewhere; redirect messages omit the query because it can hold a token. Responses are forced to application/json or application/octet-stream with nosniff, attachment and a sandbox CSP so project content cannot run on the Console origin. Host middleware such as the signature check answers with a diagnostic body and no birpc reply, so signedProjectCall falls back to that body.

**Consequences:** Forwarding more headers leaks Console cookies or credentials to projects; re-serializing the body breaks signatures; following redirects or echoing project content types opens SSRF/XSS on the Console origin.

## Redirects from Cloudflare Access get a dedicated diagnostic

`redirectProblem` in `packages/console/src/forward.ts`.

**Context:** Apps once used Cloudflare Access in front of them for an older Console. Access redirects every call without an Access session to its sign-in page.

**Decision:** A redirect with a Cloudflare-Access www-authenticate header or a *.cloudflareaccess.com location returns CONSOLE_FORWARD_REDIRECT with a fix to delete the Access application or add a Bypass policy.

**Consequences:** Removing the detection turns a common migration problem into a generic redirect error.

## Older apps that refuse MCP caller fields are diagnosed, never retried without them

`refusedCallerFields`, `outdatedApp`, `callProjectOperation`, `checkProject` in `packages/console/server/utils/console.ts`.

**Context:** Apps before vite-hub #4052 refuse the caller fields surface and confirmed, and apps before #4624 refuse readOnly, with 401 CONSOLE_SIGNATURE_INVALID. They still accept the Console page caller fields.

**Decision:** callProjectOperation does not resend an MCP call without the MCP fields, because those fields are the rules the app applies (an old app would run the call without them); it reads project.get as a page call and answers CONSOLE_APP_VITEHUB_OUTDATED with the version. checkProject alone retries project.get without MCP fields because it only reads.

**Consequences:** Retrying operations without MCP fields would bypass mcp:false, confirmation, and readOnly on old apps. The compat path can go once no linked app predates #4624.

## MCP tool errors use 4xx so the Agent sees the text

`consoleToolError`, `projectOperation` in `packages/console/server/utils/mcp.ts`.

**Context:** H3/the MCP layer hides the message of a 5xx tool error from the Agent.

**Decision:** consoleToolError maps any non-4xx Console status to 400; projectOperation reports app failures as 400 and passes the app message through, which is safe because the app already hides its own server errors.

**Consequences:** Passing 5xx through would hide every fix message from the Agent.

## An MCP access token acts on the team of the person's newest session

`consoleActiveTeam` in `packages/console/server/utils/console.ts`.

**Context:** An OAuth access token has no session and so no active team.

**Decision:** The team is the active team of the person's newest session (the team opened last in the Console), else their first team.

**Consequences:** Reading the team from elsewhere changes which team's apps an Agent touches.

## Env reveal writes audit rows before the value leaves, and fails whole

`consoleEnvRoute (reveal branch)` in `packages/console/server/utils/env-values.ts`, `packages/console/scripts/env-smoke.mjs`, `packages/console/test/env-values.test.ts`.

**Context:** Env values are secrets; the activity log must name who took each one.

**Decision:** Each value gets a `started` row before the read and an outcome row (`succeeded` or `failed`) before the response. If the keyring cannot open one value, the whole reveal fails and no value leaves.

**Consequences:** Writing the rows after the response, or returning partial results, lets a value leave without an audit row.

## Env key rotation runs once per process and never fails a request

`rotateOnce`, `rotation` in `packages/console/server/utils/env-values.ts`.

**Context:** VITEHUB_CONSOLE_ENV_KEYS may list several keys during rotation.

**Decision:** With two or more keys, the first env request reseals all values with the current key; reads keep working through the keyring; a failed rotation resets the promise and logs, so the next request retries.

**Consequences:** Failing requests on rotation errors would take env values down during a key change; dropping the reset makes one failure permanent.

## Private host check decodes IPv4-mapped IPv6 in hex form

`isPrivateHost` in `packages/console/src/project-url.ts`.

**Context:** The WHATWG URL parser serializes ::ffff:127.0.0.1 as ::ffff:7f00:1.

**Decision:** isPrivateHost decodes the two hex groups back to IPv4 and checks that.

**Consequences:** Matching only dotted forms lets a mapped loopback/private address pass the SSRF check.

## Unmatched API, MCP, and well-known paths stay 404

`default export of server/routes/[...].ts` in `packages/console/server/routes/[...].ts`.

**Context:** Every other path is a client route that gets the Console page.

**Decision:** /api, /p, /assets, /mcp and /.well-known paths that no route answers return a JSON 404, so an MCP client finds no OAuth metadata for /mcp (only /mcp/account has OAuth).

**Consequences:** Serving the page there makes MCP clients think /mcp needs OAuth and hides API 404s behind HTML.

## MCP OAuth page: public-client prelogin and only signed parameters

`mcpOAuth options (allowPublicClientPrelogin)`, `oauthPageScript` in `packages/console/server/auth.ts`, `packages/console/src/oauth-page.injected.ts`, `packages/console/test/oauth-page.test.ts`.

**Context:** Better Auth's OAuth provider sends login and consent to /oauth with a signed query.

**Decision:** allowPublicClientPrelogin is on so the page can show the registered client name before sign-in. The page script sends back only the parameters listed in ba_param, the ones the provider signed.

**Consequences:** Forwarding extra query parameters breaks or weakens the signed authorization resume.

## Node Console SQLite lives under the data folder, baked at build time

`dataDir`, `database()`, `hosts.node.extra` in `packages/console/vite.config.ts`, `packages/console/scripts/host-smoke.mjs`.

**Context:** The Dockerfile mounts only the data folder. vitehub's dataDir moves the other local stores but not the Database.

**Decision:** The build writes VITEHUB_DATA_DIR into the server, so Docker builds use /data; the Database URL is set explicitly to <dataDir>/database/sqlite.db with migrateOnStart. The host smoke checks the file is there.

**Consequences:** Building with another data dir, or relying on dataDir for the Database, puts the database outside the volume and loses it with the container.

## publicUrl comes from VITEHUB_CONSOLE_PUBLIC_URL

`vitehub({ publicUrl })` in `packages/console/vite.config.ts`.

**Context:** On Node, Host and forwarding headers are client-controlled.

**Decision:** The Console's own origin comes from VITEHUB_CONSOLE_PUBLIC_URL, never from request headers.

**Consequences:** Deriving it from headers lets a client forge the deployment identity.

## Host smoke clamps the Cloudflare compatibility date to local workerd

`hosts.cloudflare`, `workerdCompatibilityDate` in `packages/console/scripts/host-smoke.mjs`.

**Context:** The build writes the build date as compatibility_date; the installed workerd may not support that date yet.

**Decision:** wrangler dev runs with the newest date workerd supports when the build date is newer.

**Consequences:** Removing the clamp makes the Cloudflare smoke fail whenever workerd lags the calendar.

## Resolve workerd through Wrangler's real path

`workerdCompatibilityDate` in `packages/console/scripts/host-smoke.mjs`.

**Context:** pnpm symlinks node_modules/wrangler into its store, where miniflare and workerd live.

**Decision:** createRequire starts from realpathSync of wrangler's package.json, then miniflare, then workerd.

**Consequences:** Resolving from the symlink path does not find Wrangler's own dependencies.

## Host smoke ends with process.exit

`top level of scripts/host-smoke.mjs` in `packages/console/scripts/host-smoke.mjs`.

**Context:** The Vercel function runs in the smoke process and keeps timers and connections open.

**Decision:** The script calls process.exit() after setting exitCode.

**Consequences:** Without it the Vercel smoke never exits in CI.

## The CLI sign-in check doubles as the latest-migration probe

`checks: "writes and reads a CLI sign-in code in the database"` in `packages/console/scripts/smoke.mjs`.

**Context:** device_code comes from the newest migration, 20261115091657_cli_auth.

**Decision:** The smoke proves the host applied the latest migration by writing and reading a device code.

**Consequences:** When a newer migration lands, this check no longer proves the latest one ran; add a check that touches the new tables.

## Console migrations after the first only add tables

`migrations test` in `packages/console/test/migrations.test.ts`.

**Context:** SQLite table rebuilds (DROP/ALTER/INSERT INTO copy) on tables that sessions and memberships cascade from can delete rows through ON DELETE CASCADE.

**Decision:** The comments and cli_auth migrations must not contain DROP TABLE, ALTER TABLE, or INSERT INTO.

**Consequences:** A rebuilding migration can wipe sessions and memberships on deploy.

## Account MCP tools declare read-only and destructive hints

`read_operation`, `run_operation`, `account MCP tools` in `packages/console/test/mcp.test.ts`.

**Context:** MCP clients such as Executor ask the person before a tool that is not read-only.

**Decision:** Read tools declare readOnlyHint true and destructiveHint false; run_operation declares destructive.

**Consequences:** Wrong hints make clients prompt for every read or run writes without asking.

## A Console build without the Console page bundles a placeholder page and warns

`vitehub-console-page` plugin `load()` in `packages/console/vite.config.ts`.

**Context:** `pnpm --filter vite-hub build:console-account` builds the Console page. The repository-wide `build` task, the affected-package runner (`test/run-package-task.mjs`), and the Console `typecheck` and `test` scripts all build `@vite-hub/console` without it. A failing build there would make every package build first build the Console page, which is a full Vue app build.

**Decision:** Without the page, the build warns and bundles a placeholder. The `console` CI job builds the page first, and `scripts/host-smoke.mjs` fails when the running Console serves the placeholder, so `console-deploy` never ships it.

**Consequences:** A manual deploy that skips `build:console-account` ships the placeholder with only a build warning. Fail the build when `vitehub console deploy` exists and builds the page itself, or when the repository build gets a separate deploy build of the Console.
