# @vite-hub/connections decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Google Discovery marks required fields in descriptions

`isRequiredProperty` in `packages/connections/scripts/generate-google.ts`.

**Context:** The Gmail Discovery document often leaves out required; the description starts with "Required." instead.

**Decision:** A property is required when required is true or its description starts with "Required.".

**Consequences:** Without the description check, required Gmail body fields become optional in the generated types.

## Snapshot API key origins with structuredClone

`isValidApiKeyProvider` in `packages/connections/src/api-key.ts`.

**Context:** Origins come from user code and could be a Proxy or an array with getters that change between check and use.

**Decision:** Validate a structuredClone copy; it throws on a Proxy and the surrounding try returns false.

**Consequences:** A spread or direct read lets a hostile origins value pass validation and send the key elsewhere.

## CLI completion timeout covers the server exchange budget

`request` in `packages/connections/src/cli.ts`.

**Context:** complete() runs a token exchange with a 30 s timeout, then identity checks and durable writes; cli.test.ts covers a response after 30 s.

**Decision:** The complete action waits 120 s; other actions wait 30 s.

**Consequences:** A shorter timeout reports failure while the server saves the grant, and the one-use state is gone so the user cannot retry.

## The CLI never puts API keys in argv or sends them through a redirect

`readKey`, `set-key command` in `packages/connections/src/cli.ts`.

**Context:** set-key sends a secret to the app management API.

**Decision:** Read the key only from piped stdin; send set-key with redirect: "error".

**Consequences:** A --key flag leaks keys into shell history; following redirects could send the key to another origin.

## Diagnostic fix text is written literally for the docs catalog reader

`connect` in `packages/connections/src/error-diagnostics.ts`.

**Context:** docs/modules/diagnostics/catalog.ts textOf() reads only string and template literals and turns ${expr} into <placeholder>.

**Decision:** Write route and command prefixes literally in why/fix text.

**Consequences:** Text built through helpers shows <placeholder> instead of commands on the docs pages.

## OAuth callbacks of flows started in the Console skip the app access policy

`createConnectionsHandler`, `CONSOLE_STATE_PREFIX`, `config (callbackOnly)` in `packages/connections/src/http.ts`, `packages/connections/src/runtime.ts`, `packages/connections/src/vite.ts`.

**Context:** The hosted Console starts authorize({ via: "console" }); the provider returns the browser to the app /callback with no app session.

**Decision:** Handle the callback before the access policy, recognise it by the console_ state prefix, and in production without management mount only the callback route.

**Consequences:** Access check first breaks Console connects in production; a looser prefix check lets any callback skip the actor check.

## The development policy trusts only loopback requests signed by the front process

`checkConnectionsAccess`, `config (nitro setup)` in `packages/connections/src/internal/http-access.ts`, `packages/connections/src/vite.ts`.

**Context:** The Nitro 3 dev worker sits behind a Unix-socket proxy with no peer address, and x-forwarded-for can be forged.

**Decision:** The front process signs loopback requests; the dev policy checks them with isViteHubLoopbackPeer.

**Consequences:** Without the signer local management is denied; trusting headers lets a LAN client manage Connections.

## Origin checks behind TLS-terminating proxies

`originRejection`, `connect route` in `packages/connections/src/internal/http-routes.ts`.

**Context:** Behind a TLS proxy the server sees an http:// request URL; http.test.ts covers it.

**Decision:** Accept the public origin, or the request origin only when its host equals the public host; build redirect_uri from the public origin.

**Consequences:** Request-origin only breaks proxied deployments; trusting Host widens the CSRF check.

## MCP OAuth discovery follows RFC 9728, RFC 8414 and RFC 8707

`resourceMetadataUrls`, `serverMetadataUrls`, `discoverAuthorizationServer`, `oauthClient` in `packages/connections/src/internal/oauth-discovery.ts`, `packages/connections/src/runtime.ts`.

**Context:** MCP clients must find metadata in spec order, check the issuer and send resource; oauth-registration.test.ts covers it. The resource check is only same-origin, looser than RFC 9728 3.3.

**Decision:** Try URLs in spec order, reject metadata whose issuer does not match, send the resource parameter.

**Consequences:** Reordering or dropping the issuer check breaks real MCP servers or opens issuer mix-up.

## One stored, dynamically registered client per issuer and callback

`clientRegistrations`, `oauthClient`, `tokenRequest` in `packages/connections/src/internal/oauth-discovery.ts`, `packages/connections/src/runtime.ts`.

**Context:** Registrations are saved with compare-and-swap; the code exchange uses the pending client id; invalid_client forgets the registration.

**Decision:** Share one registered client, keep the pending client for the code exchange, treat client_secret_expires_at 0 as never expiring.

**Consequences:** Duplicate clients, failed exchanges after re-registration, or secrets treated as expired.

## The mcp preset never asks for approval

`decide` in `packages/connections/src/policy.ts`.

**Context:** MCP sends every protocol message as a POST on a long-lived session.

**Decision:** The mcp rule allows the mcp endpoint and denies the rest; it never returns approve.

**Consequences:** Approvals on MCP traffic would block every session.

## Long timer waits stay below the signed 32-bit limit

`sleep` in `packages/connections/src/requests.ts`.

**Context:** A Retry-After value can be very large; setTimeout above 2^31-1 ms fires at once.

**Decision:** Wait in steps of at most MAX_TIMER_MS until a performance.now() deadline.

**Consequences:** A single setTimeout fires immediately and retries against a provider that asked for a long pause.

## An approved replay runs only with the same credential; the sentinel never collides with a random grant id

`FALLBACK_GRANT`, `fallbackFor` in `packages/connections/src/runtime.ts`.

**Context:** An approval stores grantId; the fallback key uses the fixed sentinel fallback.

**Decision:** An approved replay runs only with the same credential; the sentinel never collides with a random grant id.

**Consequences:** An approval given for one credential could run with another.

## Emulate redirect error with manual redirects

`createConnectionsRuntime request` in `packages/connections/src/runtime.ts`.

**Context:** Workers fetch does not support redirect: "error".

**Decision:** Send with redirect: "manual" and throw CONNECTIONS_PROVIDER_FAILED on an opaque redirect or 3xx.

**Consequences:** Token, revocation and discovery requests would follow redirects on Workers or fail differently per host.

## Fence token mutations while the provider outcome is unknown

`withTokenMutation`, `tokenRequest`, `refreshToken`, `refreshLeasedToken`, `complete`, `revoke`, `executeApproval` in `packages/connections/src/runtime.ts`.

**Context:** Providers rotate refresh tokens and can revoke whole grants; a lost response leaves provider state unknown. runtime-mutation-leases.test.ts covers it.

**Decision:** Release a lease only after a definite provider answer and durable writes; otherwise quarantine (reauth_required) or keep the lease.

**Consequences:** Early release lets refresh, callback and revoke resurrect revoked grants, lose rotated tokens or double-run writes.

## Revocation always wins over the fallback key

`fallbackFor`, `sendWithFallback` in `packages/connections/src/runtime.ts`.

**Context:** The fallback is used only when no key state exists; a revoke writes state.

**Decision:** Do not catch state.get on an open store; claim the mutation lease and recheck state before sending.

**Consequences:** A revoked Connection could still call the provider with the fallback key.

## OAuth state is single use and is taken before any check

`complete` in `packages/connections/src/runtime.ts`.

**Context:** authorizations.take() deletes the row; runtime.test.ts and http-access.test.ts rely on it.

**Decision:** Take the state first, then check expiry, actor and error.

**Consequences:** Reading without consuming allows callback replay.

## verify() errors never echo the API key

`setKey` in `packages/connections/src/runtime.ts`.

**Context:** verify() is developer code and its errors can include the key.

**Decision:** Pass through only a ConnectionError whose why and code do not contain the key; everything else becomes CONNECTIONS_PROVIDER_FAILED.

**Consequences:** Keys leak into logs, CLI output and the Console.

## ChatGPT credential transfer hands off refresh ownership

`exportChatGPT`, `importChatGPT` in `packages/connections/src/runtime.ts`.

**Context:** ChatGPT refresh tokens rotate, so two refreshing hosts break each other; an imported ID token may already be expired.

**Decision:** Export marks the source as transferred (reauth_required); import checks the JWT at its iat and then refreshes.

**Consequences:** Two hosts fight over one grant, or valid imports are rejected as expired.

## Activity pruning relies on the text order of ISO timestamps

`pruneActivity` in `packages/connections/src/store.ts`.

**Context:** The DELETE compares json_extract(payload,'$.timestamp') with an ISO cutoff string.

**Decision:** Keep event timestamps as ISO strings.

**Consequences:** A numeric or local-format timestamp silently breaks age-based pruning.

## The destination check runs before governance

`prepare`, `callMethod`, `callFetch` in `packages/connections/src/transport.ts`, `packages/connections/src/runtime.ts`.

**Context:** callMethod and callFetch call transport.prepare() before governed().

**Decision:** Reject origins outside the allow-list before policy, dry run and approval.

**Consequences:** Approvals would be created for unsendable requests, showing attacker-chosen URLs to approvers.

## MCP streams bypass pacing, retries and timeouts

`send` in `packages/connections/src/transport.ts`.

**Context:** An MCP session is a long-lived stream.

**Decision:** Requests to the mcp endpoint skip scheduler.send.

**Consequences:** timeoutMs cuts sessions off and retries replay protocol messages.

## API key redirects are followed by hand to strip the key

`sendKey` in `packages/connections/src/transport.ts`.

**Context:** Fetch drops Authorization on cross-origin redirects but keeps custom headers such as x-api-key.

**Decision:** Use manual redirects and remove the key header once the chain leaves the first origin.

**Consequences:** redirect: "follow" leaks keys to redirect targets.

## never fields on keyed definitions for precise errors

`ConnectionInstancesDefinition` in `packages/connections/src/types.ts`.

**Context:** defineConnection() accepts a union of a plain and a keyed definition.

**Decision:** Declare api?: never and access?: never on the keyed variant.

**Consequences:** Type errors move to the whole object instead of the wrong entry.

## Atomic generated-file writes for concurrent dev servers

`writeFileIfChanged`, `refreshGeneratedFiles` in `packages/connections/src/vite.ts`.

**Context:** vite.test.ts runs two prepareTypes at once.

**Decision:** Write a temporary file and rename; output depends only on discovered definitions.

**Consequences:** A direct writeFile can leave a mix of two results in the .d.ts.

## The management action route is POST only

`addManagementHandlers` in `packages/connections/src/vite.ts`.

**Context:** The app or Console page lives at GET /_vitehub/connections.

**Decision:** Register POST for the base route and GET only for /connect/** and /callback.

**Consequences:** An all-method handler hides the page.

## The Nuxt app base is not the Vite base

`connectionManagementRoute` in `packages/connections/src/vite.ts`.

**Context:** In Nuxt the Vite base is /_nuxt/.

**Decision:** Read VITEHUB_APP_BASE_URL first, then base.

**Consequences:** Routes mount under /_nuxt/ in Nuxt apps.

## Update the live Nitro instance after the final base

`refreshManagement` in `packages/connections/src/vite.ts`.

**Context:** Nitro is set up before configResolved.

**Decision:** Patch nitroInstance.options and call routing.sync() as well as config.nitro.

**Consequences:** Routes stay on the old base.

## Watch add and unlink for colocated docs

`configureServer` in `packages/connections/src/vite.ts`.

**Context:** Adding or deleting a <name>.md changes the generated registry.

**Decision:** Watch the definition folders and refresh on add and unlink.

**Consequences:** New or deleted docs files do not show up in dev until restart.
